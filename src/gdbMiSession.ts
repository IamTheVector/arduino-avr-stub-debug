/**
 * Single avr-gdb process in GDB/MI2 mode (one serial connection to avr-stub).
 */

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as path from "path";

export type MiStoppedReason = {
  reason?: string;
  frame?: MiFrame;
  threadId?: string;
};

export type MiFrame = {
  addr?: string;
  func?: string;
  file?: string;
  line?: string;
  fullname?: string;
};

export type StackFrame = {
  level: number;
  addr: string;
  func: string;
  file?: string;
  line?: string;
  fullname?: string;
};

export type VariableRow = {
  name: string;
  value: string;
  type?: string;
};

export type RegisterRow = {
  name: string;
  value: string;
};

/** Emitted when the GDB child process exits (crash, kill, or normal quit). */
export type GdbProcessExitInfo = {
  /** True if {@link GdbMiSession.dispose} requested shutdown (Stop session / user quit). */
  intentional: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  /** Last bytes of GDB stderr (errors often appear here). */
  stderrTail: string;
};

export type GdbMiSessionOptions = {
  gdbPath: string;
  elfPath: string;
  gdbInitPath: string;
  /** Called for *stopped and after exec commands that halt */
  onStopped?: (info: MiStoppedReason) => void;
  /** Stream & and ~ from GDB */
  onLog?: (line: string, stream: "console" | "log") => void;
  /** Raw MI line for debugging */
  onDebugLine?: (line: string) => void;
  /** Child process exited (unexpected exits should be surfaced to the user). */
  onProcessExit?: (info: GdbProcessExitInfo) => void;
};

/** Escape payload for `-interpreter-exec console "..."` (must be a single MI line — real newlines break the parser). */
function escapeForConsoleArg(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/** Unescape GDB MI quoted strings */
function unescapeMiString(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Parse one-line GDB MI stream records ~"…" / &"…" / @"…" without using a naive /"(.*)"$/ regex:
 * inner text can contain escaped quotes (e.g. "fn" in the define banner) and the greedy regex drops the whole line.
 */
function parseMiStreamRecord(
  line: string
): { stream: "console" | "log" | "target"; text: string } | undefined {
  type P = { prefix: '~"' | '&"' | '@"'; stream: "console" | "log" | "target" };
  const prefixes: P[] = [
    { prefix: '~"', stream: "console" },
    { prefix: '&"', stream: "log" },
    { prefix: '@"', stream: "target" }
  ];
  for (const { prefix, stream } of prefixes) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    let i = prefix.length;
    let acc = "";
    while (i < line.length) {
      const c = line[i];
      if (c === "\\") {
        if (i + 1 >= line.length) {
          return undefined;
        }
        const n = line[i + 1];
        if (n === "n") {
          acc += "\n";
          i += 2;
          continue;
        }
        if (n === "r") {
          acc += "\r";
          i += 2;
          continue;
        }
        if (n === "t") {
          acc += "\t";
          i += 2;
          continue;
        }
        if (n === '"') {
          acc += '"';
          i += 2;
          continue;
        }
        if (n === "\\") {
          acc += "\\";
          i += 2;
          continue;
        }
        acc += n;
        i += 2;
        continue;
      }
      if (c === '"') {
        const rest = line.slice(i + 1);
        if (rest.length > 0 && rest.trim() !== "") {
          return undefined;
        }
        return { stream, text: acc };
      }
      acc += c;
      i++;
    }
    return undefined;
  }
  return undefined;
}

const STDERR_TAIL_MAX = 12_000;

export class GdbMiSession {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private tokenCounter = 0;
  private pending = new Map<
    number,
    { resolve: (v: MiResult) => void; reject: (e: Error) => void }
  >();
  private options: GdbMiSessionOptions;
  private disposed = false;
  /** Set at the start of {@link dispose} so {@link ChildProcess} `exit` is treated as intentional. */
  private extensionRequestedShutdown = false;
  private stderrTail = "";

  constructor(options: GdbMiSessionOptions) {
    this.options = options;
  }

  get running(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<void> {
    if (this.proc) {
      await this.dispose();
    }
    this.extensionRequestedShutdown = false;
    this.stderrTail = "";
    const { gdbPath } = this.options;
    const args = ["-q", "-nx", "-i=mi2"];
    this.proc = spawn(gdbPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.proc.stdout.on("data", (c: Buffer) => this.onStdout(c));
    this.proc.stderr.on("data", (c: Buffer) => {
      const t = c.toString("utf8");
      this.stderrTail = (this.stderrTail + t).slice(-STDERR_TAIL_MAX);
      this.options.onLog?.(t, "log");
    });
    this.proc.on("exit", (code, signal) => {
      const intentional = this.extensionRequestedShutdown;
      this.extensionRequestedShutdown = false;
      this.proc = undefined;
      const info: GdbProcessExitInfo = {
        intentional,
        exitCode: code,
        exitSignal: signal ?? null,
        stderrTail: this.stderrTail
      };
      this.options.onProcessExit?.(info);
    });
    this.proc.on("error", (err) => {
      this.options.onLog?.(`GDB spawn error: ${err.message}\n`, "log");
    });

    const elf = this.options.elfPath.split("\\").join("/");
    await this.sendCommand(`-file-exec-and-symbols "${elf}"`);
    const src = this.options.gdbInitPath.split("\\").join("/");
    await this.sendConsole(`source ${src}`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.extensionRequestedShutdown = true;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin.write("-gdb-exit\n");
      } catch {
        // ignore
      }
      await new Promise<void>((r) => setTimeout(r, 200));
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    this.proc = undefined;
    for (const [, p] of this.pending) {
      p.reject(new Error("GDB session ended"));
    }
    this.pending.clear();
  }

  interrupt(): void {
    if (this.proc?.pid) {
      try {
        process.kill(this.proc.pid, "SIGINT");
      } catch {
        // Windows fallback
      }
    }
  }

  async sendConsole(cmd: string): Promise<MiResult> {
    const inner = escapeForConsoleArg(cmd);
    return this.sendCommand(`-interpreter-exec console "${inner}"`);
  }

  async continueExec(): Promise<MiResult> {
    return this.sendCommand("-exec-continue");
  }

  /** Use CLI commands — same as typing in the GDB terminal (MI -exec-* can misbehave with avr-stub). */
  async next(): Promise<MiResult> {
    return this.sendConsole("next");
  }

  async step(): Promise<MiResult> {
    return this.sendConsole("step");
  }

  async finish(): Promise<MiResult> {
    return this.sendConsole("finish");
  }

  /** Reconnect: disconnect + source gdbinit again (same as fresh target remote). */
  async restartTarget(): Promise<void> {
    await this.sendConsole("disconnect");
    const src = this.options.gdbInitPath.split("\\").join("/");
    await this.sendConsole(`source ${src}`);
  }

  async stackListFrames(): Promise<StackFrame[]> {
    try {
      const r = await this.sendCommand("-stack-list-frames 0 63");
      const stack = r.result?.stack;
      if (stack && Array.isArray(stack) && stack.length > 0) {
        const frames: StackFrame[] = [];
        for (const entry of stack) {
          const f = (entry as { frame?: Record<string, string> })?.frame;
          if (!f) {
            continue;
          }
          const level = Number(f.level ?? 0);
          frames.push({
            level,
            addr: String(f.addr ?? ""),
            func: String(f.func ?? "?"),
            file: f.file ? String(f.file) : undefined,
            line: f.line ? String(f.line) : undefined,
            fullname: f.fullname ? String(f.fullname) : undefined
          });
        }
        if (frames.length > 0) {
          return frames;
        }
      }
    } catch {
      // ignore
    }
    return [];
  }

  async stackListVariables(): Promise<VariableRow[]> {
    const r = await this.sendCommand("-stack-list-variables --all-values");
    const out: VariableRow[] = [];
    const vars = r.result?.variables;
    if (vars && Array.isArray(vars)) {
      for (const v of vars) {
        const row = v as Record<string, string | undefined>;
        if (row.name !== undefined) {
          out.push({
            name: String(row.name),
            value: String(row.value ?? ""),
            type: row.type ? String(row.type) : undefined
          });
        }
      }
    }
    return out;
  }

  async dataEvaluateExpression(expr: string): Promise<string> {
    const trimmed = expr.trim();
    const tryExprs: string[] = [trimmed];

    // When the current frame changes (e.g. stepping into Arduino core),
    // GDB's MI evaluator may refuse bare global identifiers with:
    // "No symbol <name> in current context".
    // Retrying with the global namespace helps for C++-compiled Arduino sketches.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      tryExprs.push(`::${trimmed}`);
    }

    let lastErr: unknown;
    for (const e of tryExprs) {
      try {
        const inner = escapeForConsoleArg(e);
        const r = await this.sendCommand(`-data-evaluate-expression "${inner}"`);
        const v = r.result?.value;
        return v !== undefined ? String(v) : "";
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`Failed to evaluate expression: ${trimmed}`);
  }

  /**
   * Register list for the panel only (MI only — never runs `info registers` on the CLI,
   * so the AVR Stub GDB terminal is not spammed on every stop/refresh).
   */
  async listRegisters(): Promise<RegisterRow[]> {
    return this.listRegistersMi();
  }

  private async listRegistersMi(): Promise<RegisterRow[]> {
    try {
      const namesR = await this.sendCommand("-data-list-register-names");
      const names: string[] = (namesR.result?.registerNames as string[]) ?? [];
      if (names.length === 0) {
        return [];
      }
      let valsR = await this.sendCommand("-data-list-register-values x");
      let vals = (valsR.result?.registerValues as Array<{ number: string; value: string }>) ?? [];
      if (vals.length === 0) {
        valsR = await this.sendCommand("-data-list-register-values g");
        vals = (valsR.result?.registerValues as Array<{ number: string; value: string }>) ?? [];
      }
      const out: RegisterRow[] = [];
      for (const rv of vals) {
        const idx = Number(rv.number);
        out.push({
          name: names[idx] ?? `#${rv.number}`,
          value: rv.value
        });
      }
      if (out.length > 0) {
        return out;
      }
      return await this.listRegistersByMiEval(names);
    } catch {
      return [];
    }
  }

  /** Silent per-register MI eval when -data-list-register-values returns no rows. */
  private async listRegistersByMiEval(names: string[]): Promise<RegisterRow[]> {
    const out: RegisterRow[] = [];
    const max = Math.min(names.length, 64);
    for (let i = 0; i < max; i++) {
      const nm = names[i];
      try {
        const expr = nm.startsWith("$") ? nm : `$${nm}`;
        const inner = escapeForConsoleArg(expr);
        const r = await this.sendCommand(`-data-evaluate-expression "${inner}"`);
        const v = r.result?.value;
        out.push({ name: nm, value: v !== undefined ? String(v) : "?" });
      } catch {
        out.push({ name: nm, value: "?" });
      }
    }
    return out;
  }

  async readMemoryHex(address: string, length: number): Promise<string> {
    const r = await this.sendCommand(
      `-data-read-memory-bytes ${address} ${length}`
    );
    const mem = r.result?.memory as unknown[] | undefined;
    if (mem && mem.length > 0) {
      const first = mem[0] as { contents?: string };
      if (first?.contents) {
        return String(first.contents);
      }
    }
    return "";
  }

  async disassembleAroundPc(): Promise<string> {
    const r = await this.sendCommand(
      '-data-disassemble -s $pc -e "$pc+64" -- 0'
    );
    const asm = r.result?.asm_insns;
    if (!asm) {
      return "";
    }
    const lines: string[] = [];
    const src = Array.isArray(asm) ? asm : [asm];
    for (const block of src) {
      const insns = block?.line_asm_insn ?? block?.src_and_asm_line;
      if (Array.isArray(insns)) {
        for (const insn of insns) {
          if (insn?.address && insn?.inst) {
            lines.push(`${insn.address}\t${insn.inst}`);
          }
        }
      }
    }
    return lines.join("\n");
  }

  /** Sync breakpoints using GDB CLI (same as terminal flow; reliable with avr-stub). */
  async syncBreakpointsCli(
    desiredKeys: Set<string>,
    previous: Set<string>,
    interruptFirst: boolean
  ): Promise<{ next: Set<string> }> {
    const lines: string[] = [];
    if (interruptFirst) {
      this.interrupt();
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const key of previous) {
      if (!desiredKeys.has(key)) {
        const [file, line] = JSON.parse(key) as [string, number];
        lines.push(`clear ${file}:${line}`);
      }
    }
    for (const key of desiredKeys) {
      if (!previous.has(key)) {
        const [file, line] = JSON.parse(key) as [string, number];
        lines.push(`break ${file}:${line}`);
      }
    }
    const next = new Set(desiredKeys);
    for (const line of lines) {
      await this.sendConsole(line);
    }
    return { next };
  }

  async deleteAllBreakpointsCli(): Promise<void> {
    await this.sendConsole("delete breakpoints");
  }

  private async sendCommand(cmd: string): Promise<MiResult> {
    if (!this.proc?.stdin) {
      throw new Error("GDB not running");
    }
    const token = ++this.tokenCounter;
    const line = `${token}${cmd}\n`;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`GDB MI timeout: ${cmd}`));
      }, 120_000);
      this.pending.set(token, {
        resolve: (v) => {
          clearTimeout(to);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(to);
          reject(e);
        }
      });
      try {
        this.proc!.stdin.write(line);
      } catch (e) {
        this.pending.delete(token);
        clearTimeout(to);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.length === 0) {
        continue;
      }
      this.options.onDebugLine?.(line);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Async: *stopped
    if (line.startsWith("*stopped,")) {
      const info = parseStopped(line);
      this.options.onStopped?.(info);
      return;
    }
    // Notify: =thread-selected, etc.
    if (line.startsWith("=") || line.startsWith("*")) {
      if (line.startsWith("*running")) {
        return;
      }
      return;
    }
    // GDB MI stream: ~ = console, & = log, @ = target (show all in panel)
    const streamRec = parseMiStreamRecord(line);
    if (streamRec) {
      const tag = streamRec.stream === "log" ? "log" : "console";
      this.options.onLog?.(streamRec.text, tag);
      return;
    }
    if (line.startsWith('~"') || line.startsWith('&"') || line.startsWith('@"')) {
      this.options.onLog?.(`${line}\n`, "console");
      return;
    }
    // Result: N^done or N^error or N^running
    const rm = /^(\d+)\^(done|error|running|connected)(.*)$/.exec(line);
    if (rm) {
      const token = Number(rm[1]);
      const kind = rm[2];
      const rest = rm[3] ?? "";
      const pending = this.pending.get(token);
      if (!pending) {
        return;
      }
      this.pending.delete(token);
      if (kind === "error") {
        const em = /msg="((?:\\.|[^"\\])*)"/.exec(rest);
        const msg = em ? unescapeMiString(em[1]) : rest;
        pending.reject(new Error(msg));
        return;
      }
      if (kind === "running") {
        pending.resolve({ result: {} });
        return;
      }
      const result = kind === "done" ? parseMiResult(rest) : {};
      pending.resolve({ result });
      return;
    }
    // (gdb) ignore
  }
}

type MiResult = {
  result: Record<string, unknown>;
};

function parseStopped(line: string): MiStoppedReason {
  const out: MiStoppedReason = {};
  const reasonM = /reason="([^"]+)"/.exec(line);
  if (reasonM) {
    out.reason = reasonM[1];
  }
  const frameM = /frame=\{([^}]*)\}/.exec(line);
  if (frameM) {
    const f: MiFrame = {};
    const inner = frameM[1];
    const addr = /addr="([^"]+)"/.exec(inner);
    const func = /func="([^"]+)"/.exec(inner);
    const file = /file="([^"]+)"/.exec(inner);
    const lineN = /line="([^"]+)"/.exec(inner);
    const fullname = /fullname="([^"]+)"/.exec(inner);
    if (addr) {
      f.addr = addr[1];
    }
    if (func) {
      f.func = func[1];
    }
    if (file) {
      f.file = file[1];
    }
    if (lineN) {
      f.line = lineN[1];
    }
    if (fullname) {
      f.fullname = fullname[1];
    }
    out.frame = f;
  }
  return out;
}

/** Extract stack=[frame={...},...] from MI ^done payload. */
function extractStackArrayFromDone(body: string): unknown[] | undefined {
  const key = "stack=[";
  const idx = body.indexOf(key);
  if (idx < 0) {
    return undefined;
  }
  const openBracket = idx + key.length - 1;
  if (body[openBracket] !== "[") {
    return undefined;
  }
  const closeBracket = findMatchingBracketSquare(body, openBracket);
  if (closeBracket < 0) {
    return undefined;
  }
  const inner = body.slice(openBracket + 1, closeBracket);
  const frames: unknown[] = [];
  let i = 0;
  while (i < inner.length) {
    const fi = inner.indexOf("frame=", i);
    if (fi < 0) {
      break;
    }
    const brace = inner.indexOf("{", fi + 6);
    if (brace < 0) {
      break;
    }
    const close = findMatchingBracketCurly(inner, brace);
    if (close < 0) {
      break;
    }
    const tuple = inner.slice(brace, close + 1);
    const o = parseMiTuple(tuple);
    if (o) {
      frames.push({ frame: o });
    }
    i = close + 1;
  }
  return frames.length > 0 ? frames : undefined;
}

function findMatchingBracketSquare(s: string, openIdx: number): number {
  if (s[openIdx] !== "[") {
    return -1;
  }
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "[") {
      depth++;
    }
    if (s[i] === "]") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findMatchingBracketCurly(s: string, openIdx: number): number {
  if (s[openIdx] !== "{") {
    return -1;
  }
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") {
      depth++;
    }
    if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function extractMemoryBlockFromDone(body: string): unknown[] | undefined {
  const key = "memory=[";
  const idx = body.indexOf(key);
  if (idx < 0) {
    return undefined;
  }
  const openB = idx + key.length - 1;
  if (body[openB] !== "[") {
    return undefined;
  }
  const closeB = findMatchingBracketSquare(body, openB);
  if (closeB < 0) {
    return undefined;
  }
  const inner = body.slice(openB + 1, closeB);
  const blocks: unknown[] = [];
  let i = 0;
  while (i < inner.length) {
    const ob = inner.indexOf("{", i);
    if (ob < 0) {
      break;
    }
    const cb = findMatchingBracketCurly(inner, ob);
    if (cb < 0) {
      break;
    }
    const slice = inner.slice(ob, cb + 1);
    const o = parseMiTuple(slice);
    if (o) {
      blocks.push(o);
    }
    i = cb + 1;
  }
  return blocks.length > 0 ? blocks : undefined;
}

function extractRegisterNamesFromDone(body: string): string[] | undefined {
  const key = "register-names=[";
  const idx = body.indexOf(key);
  if (idx < 0) {
    return undefined;
  }
  const openB = idx + key.length - 1;
  if (body[openB] !== "[") {
    return undefined;
  }
  const closeB = findMatchingBracketSquare(body, openB);
  if (closeB < 0) {
    return undefined;
  }
  const inner = body.slice(openB + 1, closeB);
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out.push(unescapeMiString(m[1]));
  }
  return out.length > 0 ? out : undefined;
}

function extractVariablesArrayFromDone(body: string): unknown[] | undefined {
  const key = "variables=[";
  const idx = body.indexOf(key);
  if (idx < 0) {
    return undefined;
  }
  const openB = idx + key.length - 1;
  if (body[openB] !== "[") {
    return undefined;
  }
  const closeB = findMatchingBracketSquare(body, openB);
  if (closeB < 0) {
    return undefined;
  }
  const inner = body.slice(openB + 1, closeB);
  const vars: unknown[] = [];
  let i = 0;
  while (i < inner.length) {
    const ob = inner.indexOf("{", i);
    if (ob < 0) {
      break;
    }
    const cb = findMatchingBracketCurly(inner, ob);
    if (cb < 0) {
      break;
    }
    const tuple = inner.slice(ob, cb + 1);
    const o = parseMiTuple(tuple);
    if (o) {
      vars.push(o);
    }
    i = cb + 1;
  }
  return vars.length > 0 ? vars : undefined;
}

/** Parse ,key="value" or ,key={...} from ^done,result=... GDB MI (simplified). */
function parseMiResult(rest: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!rest.trim().startsWith(",")) {
    return out;
  }
  const body = rest.slice(1);
  const stackExtract = extractStackArrayFromDone(body);
  if (stackExtract !== undefined) {
    out.stack = stackExtract;
    return out;
  }
  const varExtract = extractVariablesArrayFromDone(body);
  if (varExtract !== undefined) {
    out.variables = varExtract;
    return out;
  }
  const varsM = /variables=\[(.*)\]\s*$/.exec(body);
  if (varsM) {
    out.variables = parseVariablesArray(varsM[1]);
    return out;
  }
  const evalM = /value="((?:\\.|[^"\\])*)"/.exec(body);
  if (evalM) {
    out.value = unescapeMiString(evalM[1]);
    return out;
  }
  const memExtract = extractMemoryBlockFromDone(body);
  if (memExtract !== undefined) {
    out.memory = memExtract;
    return out;
  }
  const regNamesExtract = extractRegisterNamesFromDone(body);
  if (regNamesExtract !== undefined) {
    out.registerNames = regNamesExtract;
    return out;
  }
  const regValsM = /register-values=\[(.*)\]\s*$/.exec(body);
  if (regValsM) {
    out.registerValues = parseRegisterValues(regValsM[1]);
    return out;
  }
  const asmM = /asm_insns=\[(.*)\]\s*$/.exec(body);
  if (asmM) {
    out.asm_insns = parseAsmBlock(asmM[1]);
    return out;
  }
  return out;
}

function splitMiList(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[" || ch === "{") {
      depth++;
    }
    if (ch === "]" || ch === "}") {
      depth--;
    }
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    parts.push(cur.trim());
  }
  return parts.filter(Boolean);
}

function parseVariablesArray(inner: string): unknown[] {
  const vars: unknown[] = [];
  const parts = splitMiList(inner);
  for (const p of parts) {
    if (!p.startsWith("{")) {
      continue;
    }
    const v = parseMiTuple(p);
    if (v) {
      vars.push(v);
    }
  }
  return vars;
}

function parseRegisterValues(inner: string): Array<{ number: string; value: string }> {
  const out: Array<{ number: string; value: string }> = [];
  const parts = splitMiList(inner);
  for (const p of parts) {
    const num = /number="(\d+)"/.exec(p);
    const val = /value="((?:\\.|[^"\\])*)"/.exec(p);
    if (num && val) {
      out.push({ number: num[1], value: unescapeMiString(val[1]) });
    }
  }
  return out;
}

/** Parse CLI output of <code>info registers</code> (avr-gdb / embedded targets). */
function parseAsmBlock(inner: string): unknown[] {
  return [{ line_asm_insn: parseAsmInsns(inner) }];
}

function parseAsmInsns(inner: string): unknown[] {
  const insns: unknown[] = [];
  const parts = splitMiList(inner);
  for (const p of parts) {
    if (!p.includes("inst=")) {
      continue;
    }
    const addr = /address="([^"]+)"/.exec(p);
    const inst = /inst="((?:\\.|[^"\\])*)"/.exec(p);
    if (addr && inst) {
      insns.push({ address: addr[1], inst: unescapeMiString(inst[1]) });
    }
  }
  return insns;
}

function parseMiTuple(s: string): Record<string, string> | undefined {
  const o: Record<string, string> = {};
  const re = /(\w+)="((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    o[m[1]] = unescapeMiString(m[2]);
  }
  return Object.keys(o).length ? o : undefined;
}
