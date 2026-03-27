import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import { installArduinoDebugBuildFlags, removeArduinoDebugBuildFlags } from "./arduinoDebugFlags";
import { AvrDebugWebviewProvider } from "./avrDebugWebview";
import { AvrGdbTerminalWebviewProvider } from "./avrGdbTerminalWebview";
import { GdbMiSession, StackFrame } from "./gdbMiSession";

type DebugSettings = {
  gdbPath: string;
  elfPath: string;
  serialPort: string;
  baudRate: number;
};

/** GDB-side snapshot of breakpoints we applied (JSON [file,line]). */
let gdbBreakpointSnapshot = new Set<string>();
let breakpointSyncDebounce: NodeJS.Timeout | undefined;

/** Last sourced gdbinit (for Restart in panel). */
let lastGdbInitPath = "";

let extensionContext: vscode.ExtensionContext | undefined;

/** GDB/MI session (single serial connection to the stub). */
let gdbMiSession: GdbMiSession | undefined;
let gdbIsRunning = false;

let currentExecLineDecoration: vscode.TextEditorDecorationType | undefined;
let jumpExecLineDecoration: vscode.TextEditorDecorationType | undefined;
let lastExecLocationKey = "";
let jumpFlashTimer: NodeJS.Timeout | undefined;

function initExecutionDecorations(): void {
  currentExecLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editor.wordHighlightStrongBorder")
  });
  jumpExecLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("editor.findMatchBorder")
  });
}

function clearExecutionDecorations(): void {
  if (jumpFlashTimer) {
    clearTimeout(jumpFlashTimer);
    jumpFlashTimer = undefined;
  }
  for (const ed of vscode.window.visibleTextEditors) {
    if (currentExecLineDecoration) {
      ed.setDecorations(currentExecLineDecoration, []);
    }
    if (jumpExecLineDecoration) {
      ed.setDecorations(jumpExecLineDecoration, []);
    }
  }
  lastExecLocationKey = "";
}

function frameToLocation(frame: StackFrame | undefined): { uri: vscode.Uri; line0: number } | undefined {
  if (!frame || !frame.line) {
    return undefined;
  }
  const line0 = Math.max(0, Number(frame.line) - 1);
  if (Number.isNaN(line0)) {
    return undefined;
  }
  const full = frame.fullname || frame.file;
  if (!full) {
    return undefined;
  }
  const uri = vscode.Uri.file(path.isAbsolute(full) ? full : path.resolve(full));
  return { uri, line0 };
}

async function highlightExecutionLocation(frame: StackFrame | undefined): Promise<void> {
  const loc = frameToLocation(frame);
  if (!loc) {
    return;
  }
  const r = new vscode.Range(loc.line0, 0, loc.line0, 0);
  const key = `${loc.uri.fsPath}:${loc.line0}`;
  const moved = lastExecLocationKey.length > 0 && lastExecLocationKey !== key;
  lastExecLocationKey = key;

  const targetEditor =
    vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === loc.uri.fsPath) ??
    (await vscode.window.showTextDocument(loc.uri, { preview: false, preserveFocus: true }));

  targetEditor.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

  for (const ed of vscode.window.visibleTextEditors) {
    if (currentExecLineDecoration) {
      ed.setDecorations(
        currentExecLineDecoration,
        ed.document.uri.fsPath === loc.uri.fsPath ? [r] : []
      );
    }
  }

  if (moved && jumpExecLineDecoration) {
    targetEditor.setDecorations(jumpExecLineDecoration, [r]);
    if (jumpFlashTimer) {
      clearTimeout(jumpFlashTimer);
    }
    jumpFlashTimer = setTimeout(() => {
      for (const ed of vscode.window.visibleTextEditors) {
        if (jumpExecLineDecoration) {
          ed.setDecorations(jumpExecLineDecoration, []);
        }
      }
      jumpFlashTimer = undefined;
    }, 900);
  }
}

const WORKSPACE_TEMP_GDB = "avr-stub-temp-commands.gdb";

/**
 * Prefer `.vscode/avr-stub-temp-commands.gdb` in the workspace so GDB sees a stable absolute path
 * (avoids Windows %TEMP% / 8.3 mismatch where `source` fails with "No such file").
 */
function resolveMultilineCommandsFilePath(): { filePath: string; ephemeral: boolean } {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (wf) {
    const dir = path.join(wf.uri.fsPath, ".vscode");
    fs.mkdirSync(dir, { recursive: true });
    return { filePath: path.join(dir, WORKSPACE_TEMP_GDB), ephemeral: false };
  }
  return {
    filePath: path.join(os.tmpdir(), `avr-stub-debug-${process.pid}-${Date.now()}.gdb`),
    ephemeral: true
  };
}

function writeGdbScriptFile(filePath: string, body: string): void {
  const content = body.endsWith("\n") ? body : `${body}\n`;
  // No fsync: on Windows fsyncSync often returns EPERM (Dropbox/OneDrive/AV, etc.).
  // writeFileSync is enough before GDB source.
  fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "w" });
}

/**
 * One GDB console line: `source C:/path/file.gdb` or `source "C:/path with space/file.gdb"`.
 * Forward slashes; quote only when needed (fewer MI escape edge cases than always-quoted paths).
 */
function gdbSourceConsoleCommand(absolutePath: string): string {
  let abs = path.resolve(absolutePath);
  try {
    abs = fs.realpathSync(abs);
  } catch {
    // keep resolved path
  }
  const p = abs.replace(/\\/g, "/");
  if (/[\s']/.test(p) || p.includes('"')) {
    return `source "${p.replace(/"/g, '\\"')}"`;
  }
  return `source ${p}`;
}

/**
 * Multiline commands → script file + `source` (same as manual commands_debug.gdb).
 */
async function runGdbCommandsViaTempSourceFile(lines: string[]): Promise<void> {
  if (!gdbMiSession || lines.length === 0) {
    return;
  }
  const { filePath, ephemeral } = resolveMultilineCommandsFilePath();
  try {
    writeGdbScriptFile(filePath, lines.join("\n"));
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not write GDB script: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }
  if (!fs.existsSync(filePath)) {
    void vscode.window.showErrorMessage("GDB script file was not created.");
    return;
  }
  const cmd = gdbSourceConsoleCommand(filePath);
  avrGdbTerminalView?.appendConsole(`(gdb) ${cmd}\n`);
  await gdbMiSession.sendConsole(cmd).catch(() => undefined);
  if (ephemeral) {
    setTimeout(() => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }, 60_000);
  }
}

async function processGdbConsoleLines(lines: string[]): Promise<void> {
  if (!gdbMiSession || lines.length === 0) {
    return;
  }
  const normalized = lines
    .map((s) => s.replace(/\r$/, "").replace(/\s+$/, ""))
    .filter((s) => s.length > 0);

  if (normalized.length === 0) {
    return;
  }

  if (normalized.length > 1) {
    await runGdbCommandsViaTempSourceFile(normalized);
  } else {
    await executeGdbLineCommand(normalized[0]!, false);
  }
  await refreshUserVariablesFromGdb();
  await refreshAvrDebugPanel();
}

let avrDebugView: AvrDebugWebviewProvider | undefined;
let avrGdbTerminalView: AvrGdbTerminalWebviewProvider | undefined;
let watchExpressions: { expr: string; value: string }[] = [];
/** User-selected symbols/expressions — values from GDB at runtime (MI). */
let userVariables: { name: string; value: string }[] = [];

const USER_VAR_KEYS = "avrStubDebug.userVariableNames";

function readSettings(): DebugSettings {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  return {
    gdbPath: cfg.get<string>("gdbPath", "avr-gdb"),
    elfPath: cfg.get<string>("elfPath", "${workspaceFolder}/build/sketch.elf"),
    serialPort: cfg.get<string>("serialPort", ""),
    baudRate: cfg.get<number>("baudRate", 115200)
  };
}

async function ensureWorkspaceFolder(): Promise<vscode.WorkspaceFolder> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Open a folder workspace first.");
  }
  return folder;
}

async function setupWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<void> {
  const settings = readSettings();
  const detectedGdbPath = resolveGdbPath(folder, settings);
  const detectedElfPath = resolveElfPath(folder, settings);
  const detectedSerialPort = resolveSerialPort(settings);
  const autoSkips = getDynamicSkipCommands(detectedGdbPath, detectedElfPath, folder.uri.fsPath);
  const vscodeDir = vscode.Uri.file(path.join(folder.uri.fsPath, ".vscode"));
  await vscode.workspace.fs.createDirectory(vscodeDir);

  const launchPath = vscode.Uri.file(path.join(vscodeDir.fsPath, "launch.json"));
  const tasksPath = vscode.Uri.file(path.join(vscodeDir.fsPath, "tasks.json"));
  const gdbInitPath = vscode.Uri.file(path.join(vscodeDir.fsPath, "avr-stub.gdbinit"));

  const launch = {
    version: "0.2.0",
    configurations: [
      {
        name: "AVR Stub Debug (Arduino IDE 2.x)",
        type: "cppdbg",
        request: "launch",
        program: detectedElfPath,
        cwd: "${workspaceFolder}",
        MIMode: "gdb",
        miDebuggerPath: detectedGdbPath,
        stopAtEntry: false,
        externalConsole: false,
        setupCommands: [
          { text: "set pagination off" },
          { text: "set print pretty on" },
          { text: `target remote ${detectedSerialPort}` },
          // No "monitor reset" here: avr-stub (serial RSP) does not implement OpenOCD-style monitor
          // commands — GDB errors with "Target does not support this command." PlatformIO avr-stub
          // flow uses target remote to the stub, not localhost:3333 + monitor.
          ...coreSkipCommands().map((text) => ({ text })),
          ...autoSkips.map((text) => ({ text }))
        ],
        logging: {
          engineLogging: false,
          trace: false
        }
      }
    ]
  };

  const tasks = {
    version: "2.0.0",
    tasks: [
      {
        label: "avr-stub: pre-debug checklist",
        type: "shell",
        command: "echo Verify: sketch uploaded with avr-stub, serial port configured, ELF path valid",
        problemMatcher: []
      }
    ]
  };

  const gdbInit = [
    "set pagination off",
    "set print pretty on",
    "set confirm off",
    "set breakpoint pending on",
    `target remote ${detectedSerialPort}`,
    ...coreSkipCommands(),
    ...autoSkips
  ].join("\n");

  await vscode.workspace.fs.writeFile(launchPath, Buffer.from(JSON.stringify(launch, null, 2), "utf8"));
  await vscode.workspace.fs.writeFile(tasksPath, Buffer.from(JSON.stringify(tasks, null, 2), "utf8"));
  await vscode.workspace.fs.writeFile(gdbInitPath, Buffer.from(gdbInit, "utf8"));
}

async function createSketchTemplate(folder: vscode.WorkspaceFolder): Promise<void> {
  const sketchPath = vscode.Uri.file(path.join(folder.uri.fsPath, "avr_stub_template.ino"));
  const code = `#include <Arduino.h>
#include "avr8-stub.h"
#include "app_api.h"

void setup() {
  debug_init();
  // Initial marker: set a breakpoint here.
}

void loop() {
  // Example loop for pause/continue testing.
  static uint32_t counter = 0;
  counter++;
  delay(100);
}
`;
  await vscode.workspace.fs.writeFile(sketchPath, Buffer.from(code, "utf8"));
}

class CppDbgResolveProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (config.type !== "cppdbg") {
      return config;
    }

    const settings = readSettings();
    const currentFolder = _folder ?? vscode.workspace.workspaceFolders?.[0];
    const detectedGdbPath = currentFolder ? resolveGdbPath(currentFolder, settings) : settings.gdbPath;
    const detectedElfPath = currentFolder ? resolveElfPath(currentFolder, settings) : settings.elfPath;
    const detectedSerialPort = resolveSerialPort(settings);
    const autoSkips = currentFolder
      ? getDynamicSkipCommands(detectedGdbPath, detectedElfPath, currentFolder.uri.fsPath)
      : [];
    config.MIMode = config.MIMode ?? "gdb";
    config.miDebuggerPath = config.miDebuggerPath ?? detectedGdbPath;
    config.program = config.program ?? detectedElfPath;
    config.cwd = config.cwd ?? "${workspaceFolder}";
    config.setupCommands = config.setupCommands ?? [
      { text: "set pagination off" },
      { text: "set print pretty on" },
      { text: `target remote ${detectedSerialPort}` },
      ...coreSkipCommands().map((text) => ({ text })),
      ...autoSkips.map((text) => ({ text }))
    ];

    return config;
  }
}

function expandWorkspaceVars(value: string, folder: vscode.WorkspaceFolder): string {
  return value.split("${workspaceFolder}").join(folder.uri.fsPath);
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveGdbPath(folder: vscode.WorkspaceFolder, settings: DebugSettings): string {
  const configured = expandWorkspaceVars(settings.gdbPath, folder);
  if (
    configured &&
    configured !== "avr-gdb" &&
    configured !== "avr-gdb.exe" &&
    fileExists(configured)
  ) {
    return configured;
  }

  const workspaceParent = path.dirname(folder.uri.fsPath);
  const home = os.homedir();
  const candidates: string[] = [
    path.join(workspaceParent, "libraries", "avr-debugger", "avr-gdb.exe"),
    path.join(home, "Dropbox", "Arduino", "libraries", "avr-debugger", "avr-gdb.exe"),
    path.join(home, "Documents", "Arduino", "libraries", "avr-debugger", "avr-gdb.exe"),
    path.join(home, "AppData", "Local", "Arduino15", "packages", "arduino", "tools", "avr-gcc"),
    path.join(home, "AppData", "Local", "Arduino15", "packages", "builtin", "tools", "avr-gcc")
  ];

  // Add sketchbook-based candidates from arduino-cli config, if available.
  try {
    const cfgJson = execSync("arduino-cli config dump --format json", { encoding: "utf8" }).trim();
    if (cfgJson) {
      const parsed = JSON.parse(cfgJson) as {
        directories?: { user?: string };
      };
      const userDir = parsed.directories?.user;
      if (userDir) {
        candidates.push(path.join(userDir, "libraries", "avr-debugger", "avr-gdb.exe"));
      }
    }
  } catch {
    // ignore and continue with static candidates
  }

  for (const candidate of candidates) {
    // For AVR-GCC tool folders, pick the newest installed avr-gdb.exe under versioned dirs.
    if (candidate.toLowerCase().endsWith(path.join("tools", "avr-gcc").toLowerCase())) {
      const roots = collectFilesRecursive(candidate, ".exe")
        .filter((p) => /[\\/]bin[\\/]avr-gdb\.exe$/i.test(p));
      const newest = newestFile(roots);
      if (newest && fileExists(newest)) {
        return newest;
      }
      continue;
    }
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  // If PATH has avr-gdb.exe, this may still work. Prefer explicit exe name on Windows.
  return configured === "avr-gdb" ? "avr-gdb.exe" : configured;
}

function isBareExecutableName(p: string): boolean {
  const t = p.trim();
  if (!t) {
    return true;
  }
  if (t.includes("\\") || t.includes("/") || t.includes(":")) {
    return false;
  }
  return true;
}

async function pickGdbExecutableFromUser(
  folder: vscode.WorkspaceFolder,
  reason?: string
): Promise<string | undefined> {
  const hint = reason
    ? `${reason}\n\nSelect avr-gdb.exe manually.`
    : "avr-gdb.exe not found automatically.\n\nSelect avr-gdb.exe manually.";
  const choice = await vscode.window.showWarningMessage(
    hint,
    { modal: true },
    "Select avr-gdb.exe",
    "Cancel"
  );
  if (choice !== "Select avr-gdb.exe") {
    return undefined;
  }
  const uris = await vscode.window.showOpenDialog({
    title: "Select avr-gdb executable",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: folder.uri,
    filters: {
      Executable: ["exe"],
      All: ["*"]
    }
  });
  const picked = uris?.[0]?.fsPath;
  if (!picked) {
    return undefined;
  }
  await vscode.workspace
    .getConfiguration("avrStubDebug")
    .update("gdbPath", picked, vscode.ConfigurationTarget.Workspace);
  return picked;
}

function normalizeSerialPortForGdb(port: string): string {
  const trimmed = port.trim();
  if (process.platform === "win32") {
    const match = /^COM(\d+)$/i.exec(trimmed);
    if (match) {
      // GDB (avr-stub target remote) in Win32 needs the device path form `\\.\COMx`.
      // Even for COM<10, passing plain `COM5` can be treated as a filename.
      return `\\\\.\\COM${match[1]}`;
    }
  }
  // Linux/macOS serial paths are typically /dev/tty* or /dev/cu.* and should pass as-is.
  return trimmed;
}

function newestFile(paths: string[]): string | undefined {
  let best: { p: string; m: number } | undefined;
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (!best || st.mtimeMs > best.m) {
        best = { p, m: st.mtimeMs };
      }
    } catch {
      // ignore unreadable file
    }
  }
  return best?.p;
}

function collectFilesRecursive(root: string, extension: string, out: string[] = []): string[] {
  if (!fileExists(root)) {
    return out;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, extension, out);
    } else if (entry.isFile() && full.toLowerCase().endsWith(extension.toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function resolveElfPath(folder: vscode.WorkspaceFolder, settings: DebugSettings): string {
  const configured = expandWorkspaceVars(settings.elfPath, folder);
  if (fileExists(configured)) {
    return configured;
  }

  const sketchName = path.basename(folder.uri.fsPath);
  const localArduinoSketches = path.join(os.homedir(), "AppData", "Local", "arduino", "sketches");
  const elfCandidates = collectFilesRecursive(localArduinoSketches, ".elf");
  if (elfCandidates.length === 0) {
    return configured;
  }

  const matchingByName = elfCandidates.filter((p) =>
    p.toLowerCase().includes(`${sketchName.toLowerCase()}.ino.elf`)
  );
  const bestMatch = newestFile(matchingByName);
  if (bestMatch) {
    return bestMatch;
  }

  const newestAny = newestFile(elfCandidates);
  return newestAny ?? configured;
}

type SerialPortEntry = { id: string; name: string };

function normalizeComId(raw: string): string | undefined {
  const t = String(raw ?? "").trim();
  if (!t) {
    return undefined;
  }
  if (t.startsWith("/dev/")) {
    return t;
  }
  if (/^tty[A-Za-z]/.test(t)) {
    return `/dev/${t}`;
  }
  const dev = /^\\\\\.\\COM(\d+)$/i.exec(t);
  if (dev) {
    return `COM${dev[1]}`;
  }
  const m = /^COM(\d+)$/i.exec(t);
  return m ? `COM${m[1]}` : undefined;
}

function listSerialPortsFromArduinoCliSync(): SerialPortEntry[] {
  try {
    // Arduino IDE 2.x uses arduino-cli under the hood; this usually works when
    // Win32_SerialPort is blocked/empty.
    const stdout = execSync("arduino-cli board list --format json", {
      encoding: "utf8"
    }).trim();
    if (!stdout) {
      return [];
    }
    type PortInfo = {
      port?: { address?: string };
      matching_boards?: Array<{ fqbn?: string }>;
    };
    const data = JSON.parse(stdout) as { detected_ports?: PortInfo[] };
    const ports = data.detected_ports ?? [];
    const out: SerialPortEntry[] = [];
    for (const p of ports) {
      const addr = p.port?.address;
      const id = addr ? normalizeComId(addr) : undefined;
      if (!id) continue;
      const boards = (p.matching_boards ?? []).map((b) => b.fqbn).filter(Boolean) as string[];
      const boardLabel = boards.length > 0 ? boards.join(", ") : "Unknown board";
      out.push({
        id,
        name: `${id} - ${boardLabel}`
      });
    }
    // De-dup by id (same port can map to multiple boards)
    const map = new Map<string, SerialPortEntry>();
    for (const e of out) {
      map.set(e.id.toUpperCase(), e);
    }
    return Array.from(map.values());
  } catch {
    return [];
  }
}

function listSerialPortsFromSystemSync(): SerialPortEntry[] {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const ps =
      "Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name | ConvertTo-Json -Compress";
    const raw = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8" }).trim();
    if (!raw) {
      return [];
    }
    type PortInfo = { DeviceID?: string; Name?: string };
    const parsed = JSON.parse(raw) as PortInfo | PortInfo[];
    const items = (Array.isArray(parsed) ? parsed : [parsed]).filter((x) => !!x.DeviceID);
    return items
      .map((p) => {
        const id = normalizeComId(String(p.DeviceID ?? ""));
        if (!id) return undefined;
        const nm = String(p.Name ?? "").trim() || id;
        return { id, name: `${id} - ${nm}` } satisfies SerialPortEntry;
      })
      .filter((x): x is SerialPortEntry => !!x);
  } catch {
    return [];
  }
}

function listSerialPortsFromDotNetSync(): SerialPortEntry[] {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const ps =
      "[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object | ConvertTo-Json -Compress";
    const raw = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8" }).trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as string | string[];
    const names = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
    return names
      .map((n) => normalizeComId(String(n)))
      .filter((x): x is string => !!x)
      .map((id) => ({ id, name: id }));
  } catch {
    return [];
  }
}

function listSerialPortsSync(): SerialPortEntry[] {
  const fromCli = listSerialPortsFromArduinoCliSync();
  if (fromCli.length > 0) return fromCli;
  const fromWmi = listSerialPortsFromSystemSync();
  if (fromWmi.length > 0) return fromWmi;
  return listSerialPortsFromDotNetSync();
}

function serialPortConfiguredExplicitly(): boolean {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  const inspected = cfg.inspect<string>("serialPort");
  return Boolean(
    inspected?.workspaceFolderValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.globalValue !== undefined
  );
}

function resolveSerialPort(settings: DebugSettings): string {
  const configured = settings.serialPort;
  const configuredNorm = normalizeComId(configured ?? "") ?? String(configured ?? "").trim();

  // If user explicitly configured the port, always honor it.
  if (serialPortConfiguredExplicitly() && configuredNorm) {
    return normalizeSerialPortForGdb(configuredNorm);
  }

  // Otherwise: try auto-detection (arduino-cli first, then system).
  const ports = listSerialPortsSync();
  if (ports.length > 0) {
    const preferred = ports.find((p) =>
      /arduino|wch|ch340|usb serial|mega|uno/i.test(p.name)
    );
    const picked = preferred ?? ports[0];
    return normalizeSerialPortForGdb(picked.id);
  }

  // Last resort: only use configured value if it was explicit. Otherwise fail fast.
  if (serialPortConfiguredExplicitly() && configured) {
    return normalizeSerialPortForGdb(configured);
  }
  throw new Error(
    "No serial port detected. Select a COM port from the AVR Debug panel, then start again."
  );
}

/** GDB `skip file` for Arduino core sources (path must match your AVR core install). */
function coreSkipCommands(): string[] {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  const enabled = cfg.get<boolean>("skipArduinoCoreSources", false);
  if (!enabled) {
    return [];
  }
  const base =
    "C:/Users/Vector_len/AppData/Local/Arduino15/packages/arduino/hardware/avr/1.8.7/cores/arduino";
  return [
    `skip file ${base}/wiring.c`,
    `skip file ${base}/wiring_digital.c`,
    `skip file ${base}/main.cpp`
  ];
}

function quoteForShell(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

function normalizePath(p: string): string {
  return p.split("\\").join("/");
}

function getDynamicSkipCommands(gdbPath: string, elfPath: string, workspaceRoot: string): string[] {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  if (!cfg.get<boolean>("enableDynamicSourceSkips", false)) {
    return [];
  }
  const max = cfg.get<number>("maxDynamicSkipFiles", 48);
  return dynamicSkipCommands(gdbPath, elfPath, workspaceRoot, max);
}

function dynamicSkipCommands(
  gdbPath: string,
  elfPath: string,
  workspaceRoot: string,
  maxFiles: number
): string[] {
  if (!fileExists(gdbPath) || !fileExists(elfPath)) {
    return [];
  }

  try {
    const cmd = `${quoteForShell(gdbPath)} -batch -ex "info sources" ${quoteForShell(elfPath)}`;
    const output = execSync(cmd, { encoding: "utf8" });
    const regex = /[A-Za-z]:[^\r\n,]+?\.(?:c|cc|cpp|cxx|ino|h|hpp|S)/g;
    const matches = output.match(regex) ?? [];
    const ws = normalizePath(workspaceRoot).toLowerCase();
    const unique = new Set<string>();

    for (const raw of matches) {
      const normalized = normalizePath(raw.trim());
      if (!normalized.toLowerCase().startsWith(ws)) {
        unique.add(normalized);
      }
    }

    return Array.from(unique)
      .slice(0, Math.max(0, maxFiles))
      .map((p) => `skip file ${p}`);
  } catch {
    return [];
  }
}

function saveUserVariableNames(): void {
  if (!extensionContext) {
    return;
  }
  void extensionContext.workspaceState.update(
    USER_VAR_KEYS,
    userVariables.map((v) => v.name)
  );
}

/** Reset displayed values so a new/stopped session does not show stale numbers from the previous run. */
function resetUserAndWatchDisplayValues(): void {
  for (const v of userVariables) {
    v.value = "...";
  }
  for (const w of watchExpressions) {
    w.value = "...";
  }
}

async function refreshUserVariablesFromGdb(): Promise<void> {
  if (!gdbMiSession) {
    return;
  }
  for (const v of userVariables) {
    try {
      v.value = await gdbMiSession.dataEvaluateExpression(v.name);
    } catch (e) {
      v.value = `(${e instanceof Error ? e.message : String(e)})`;
    }
  }
}

async function refreshWatchFromGdb(): Promise<void> {
  if (!gdbMiSession) {
    return;
  }
  for (const w of watchExpressions) {
    try {
      w.value = await gdbMiSession.dataEvaluateExpression(w.expr);
    } catch {
      w.value = "?";
    }
  }
}

async function onDebuggerStopped(): Promise<void> {
  gdbIsRunning = false;
  try {
    const frames = await gdbMiSession?.stackListFrames();
    await highlightExecutionLocation(frames?.[0]);
  } catch {
    // ignore
  }
  await refreshUserVariablesFromGdb();
  await refreshWatchFromGdb();
  await refreshAvrDebugPanel();
}

async function refreshAvrDebugPanel(): Promise<void> {
  if (!avrDebugView) {
    return;
  }
  const skipArduinoCoreSources = vscode.workspace
    .getConfiguration("avrStubDebug")
    .get<boolean>("skipArduinoCoreSources", false);
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  const serialPorts = listSerialPortsSync();
  const selectedSerialPortRaw = cfg.get<string>("serialPort", "COM5");
  const selectedNormalized = (() => {
    const s = String(selectedSerialPortRaw ?? "").trim();
    const m1 = /^\\\\\.\\\s*COM(\d+)$/i.exec(s);
    const m2 = /^\\\.\\\s*COM(\d+)$/i.exec(s);
    const n = m1?.[1] ?? m2?.[1];
    if (n) {
      return `COM${n}`;
    }
    return s;
  })();
  const selectedForUi = serialPorts.some(
    (p) => p.id.toUpperCase() === String(selectedNormalized ?? "").toUpperCase()
  )
    ? serialPorts.find((p) => p.id.toUpperCase() === String(selectedNormalized ?? "").toUpperCase())!.id
    : serialPorts[0]?.id ?? String(selectedNormalized ?? "");
  const bpRows: Array<{ file: string; line: number; enabled: boolean }> = [];
  for (const bp of vscode.debug.breakpoints) {
    if (bp instanceof vscode.SourceBreakpoint && bp.enabled) {
      bpRows.push({
        file: path.basename(bp.location.uri.fsPath),
        line: bp.location.range.start.line + 1,
        enabled: bp.enabled
      });
    }
  }

  if (!gdbMiSession) {
    avrDebugView.postFullUpdate({
      status: "Idle — run AVR Stub: Start Debug Session",
      terminalMode: true,
      debuggerMode: false,
      skipArduinoCoreSources,
      serialPorts,
      selectedSerialPort: selectedForUi,
      panelHint:
        "Start a session. Use the GDB CONSOLE in this panel (one line per Enter, like avr-gdb.exe). Expand sections below for views when the target is stopped.",
      variables: userVariables.map((v) => ({ name: v.name, value: v.value || "-", type: "" })),
      stack: [],
      registers: [],
      memory: "",
      disassembly: "",
      breakpoints: bpRows,
      watch: watchExpressions.map((w) => ({ ...w, value: w.value || "-" })),
      peripherals: []
    });
    return;
  }

  try {
    await refreshUserVariablesFromGdb();
    await refreshWatchFromGdb();
    const frames = await gdbMiSession.stackListFrames();
    const registers = await gdbMiSession.listRegisters();
    let memory = "";
    try {
      const spStr = await gdbMiSession.dataEvaluateExpression("$sp");
      const m = /0x[0-9a-fA-F]+/.exec(spStr);
      const addr = m ? parseInt(m[0], 16) : 0x8ff;
      memory = await gdbMiSession.readMemoryHex(`0x${addr.toString(16)}`, 64);
    } catch {
      memory = "(n/a)";
    }
    let disassembly = await gdbMiSession.disassembleAroundPc();
    if (!disassembly) {
      disassembly = "(n/a)";
    }

    avrDebugView.postFullUpdate({
      status: "GDB/MI active — variable/watch values refreshed from runtime (stop/interrupt)",
      terminalMode: false,
      debuggerMode: true,
      skipArduinoCoreSources,
      serialPorts,
      selectedSerialPort: selectedForUi,
      panelHint: "",
      variables: userVariables.map((v) => ({ name: v.name, value: v.value, type: "" })),
      stack: frames,
      registers,
      memory,
      disassembly,
      breakpoints: bpRows,
      watch: watchExpressions,
      peripherals: []
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    avrDebugView.postFullUpdate({
      status: `Refresh error: ${msg}`,
      terminalMode: false,
      debuggerMode: true,
      skipArduinoCoreSources,
      serialPorts,
      selectedSerialPort: selectedForUi,
      panelHint: "",
      variables: userVariables.map((v) => ({ name: v.name, value: v.value, type: "" })),
      stack: [],
      registers: [],
      memory: "",
      disassembly: "",
      breakpoints: bpRows,
      watch: watchExpressions,
      peripherals: []
    });
  }
}

async function stopGdbSession(): Promise<void> {
  gdbIsRunning = false;
  clearExecutionDecorations();
  if (gdbMiSession) {
    await gdbMiSession.dispose();
    gdbMiSession = undefined;
  }
  gdbBreakpointSnapshot.clear();
  resetUserAndWatchDisplayValues();
  await refreshAvrDebugPanel();
}

async function startGdbSession(): Promise<void> {
  const folder = await ensureWorkspaceFolder();
  const settings = readSettings();
  let gdbPath = resolveGdbPath(folder, settings);
  const elfPath = resolveElfPath(folder, settings);
  const gdbInitPath = path.join(folder.uri.fsPath, ".vscode", "avr-stub.gdbinit");
  lastGdbInitPath = gdbInitPath;

  // If discovery failed and we only have a bare command name, ask user to pick avr-gdb.exe.
  if (isBareExecutableName(gdbPath) || !fileExists(gdbPath)) {
    const picked = await pickGdbExecutableFromUser(
      folder,
      "Could not locate avr-gdb executable from known locations."
    );
    if (picked) {
      gdbPath = picked;
    }
  }

  await setupWorkspaceFiles(folder);

  if (!isBareExecutableName(gdbPath) && !fileExists(gdbPath)) {
    vscode.window.showWarningMessage(
      "avr-gdb.exe not found automatically. Check avr-debugger in sketchbook/libraries."
    );
  }
  if (!fileExists(elfPath)) {
    vscode.window.showWarningMessage("ELF not found. Build the sketch in Arduino IDE first.");
  }

  if (gdbMiSession) {
    await gdbMiSession.dispose();
    gdbMiSession = undefined;
  }
  gdbIsRunning = false;
  clearExecutionDecorations();
  resetUserAndWatchDisplayValues();

  avrGdbTerminalView?.clearConsole();

  const session = new GdbMiSession({
    gdbPath,
    elfPath,
    gdbInitPath,
    onStopped: () => {
      void onDebuggerStopped();
    },
    onLog: (line, _stream) => {
      avrGdbTerminalView?.appendConsole(line);
    }
  });
  await session.start();
  gdbMiSession = session;

  gdbBreakpointSnapshot.clear();
  const syncDelayMs = vscode.workspace.getConfiguration("avrStubDebug").get<number>("breakpointSyncDelayMs", 1000);
  setTimeout(() => {
    void syncAllBreakpointsToGdbAsync();
  }, syncDelayMs);

  await refreshAvrDebugPanel();
}

/**
 * Execute one GDB line (same routing as avr-gdb.exe: continue/step/… or raw console).
 * @param refreshAfter - if false, skip VARIABLES refresh after raw `sendConsole` (batch define/…).
 */
async function executeGdbLineCommand(command: string, refreshAfter = true): Promise<void> {
  if (!gdbMiSession) {
    return;
  }
  const t = command.trim();
  if (!t) {
    return;
  }
  const lower = t.toLowerCase();

  if (lower === "interrupt") {
    gdbMiSession.interrupt();
    await new Promise((r) => setTimeout(r, 400));
    await onDebuggerStopped();
    return;
  }
  if (lower === "continue" || lower === "c") {
    gdbIsRunning = true;
    clearExecutionDecorations();
    avrGdbTerminalView?.appendConsole("(gdb) continue\n");
    await gdbMiSession.continueExec().catch(() => undefined);
    return;
  }
  if (lower === "next" || lower === "n") {
    gdbIsRunning = true;
    avrGdbTerminalView?.appendConsole("(gdb) next\n");
    await gdbMiSession.next().catch(() => undefined);
    return;
  }
  if (lower === "step" || lower === "s") {
    gdbIsRunning = true;
    avrGdbTerminalView?.appendConsole("(gdb) step\n");
    await gdbMiSession.step().catch(() => undefined);
    return;
  }
  if (lower === "finish") {
    gdbIsRunning = true;
    avrGdbTerminalView?.appendConsole("(gdb) finish\n");
    await gdbMiSession.finish().catch(() => undefined);
    return;
  }
  if (lower === "quit" || lower === "q") {
    avrGdbTerminalView?.appendConsole("(gdb) quit\n");
    await stopGdbSession();
    return;
  }
  avrGdbTerminalView?.appendConsole(`(gdb) ${t}\n`);
  await gdbMiSession.sendConsole(t).catch(() => undefined);
  if (refreshAfter) {
    await refreshUserVariablesFromGdb();
    await refreshAvrDebugPanel();
  }
}

function sendGdbCommand(command: string, silent = false): void {
  if (!gdbMiSession) {
    if (!silent) {
      vscode.window.showErrorMessage("No GDB session. Run AVR Stub: Start Debug Session first.");
    }
    return;
  }
  void executeGdbLineCommand(command, true).catch(() => undefined);
}

function gdbPathForBreak(fsPath: string): string {
  return fsPath.split("\\").join("/");
}

function shouldSyncSourceBreakpoint(bp: vscode.SourceBreakpoint): boolean {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return false;
  }
  const fp = bp.location.uri.fsPath;
  if (!fp.toLowerCase().startsWith(folder.uri.fsPath.toLowerCase())) {
    return false;
  }
  const ext = path.extname(fp).toLowerCase();
  return [".ino", ".cpp", ".cxx", ".cc", ".c", ".h", ".hpp"].includes(ext);
}

function collectDesiredEditorBreakpoints(): Set<string> {
  const desired = new Set<string>();
  for (const bp of vscode.debug.breakpoints) {
    if (!(bp instanceof vscode.SourceBreakpoint)) {
      continue;
    }
    if (!shouldSyncSourceBreakpoint(bp)) {
      continue;
    }
    if (!bp.enabled) {
      continue;
    }
    const file = gdbPathForBreak(bp.location.uri.fsPath);
    const line = bp.location.range.start.line + 1;
    desired.add(JSON.stringify([file, line]));
  }
  return desired;
}

/**
 * Keeps GDB breakpoints in sync with editor gutter breakpoints (VS Code / Arduino IDE 2).
 */
function syncAllBreakpointsToGdb(): void {
  void syncAllBreakpointsToGdbAsync();
}

async function syncAllBreakpointsToGdbAsync(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  if (!cfg.get<boolean>("syncEditorBreakpoints", true)) {
    return;
  }
  if (!gdbMiSession) {
    return;
  }
  const desired = collectDesiredEditorBreakpoints();
  const prev = new Set(gdbBreakpointSnapshot);
  const interruptFirst = cfg.get<boolean>("breakpointSyncInterruptFirst", false);
  try {
    const { next } = await gdbMiSession.syncBreakpointsCli(desired, prev, interruptFirst);
    gdbBreakpointSnapshot = next;
  } catch {
    gdbBreakpointSnapshot = new Set(desired);
  }
}

function scheduleBreakpointSync(): void {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  if (!cfg.get<boolean>("syncEditorBreakpoints", true)) {
    return;
  }
  if (breakpointSyncDebounce) {
    clearTimeout(breakpointSyncDebounce);
  }
  const ms = cfg.get<number>("breakpointSyncDebounceMs", 350);
  breakpointSyncDebounce = setTimeout(() => {
    breakpointSyncDebounce = undefined;
    syncAllBreakpointsToGdb();
  }, ms);
}

async function addBreakpointAtCursor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Open a source file and place the cursor on a valid line.");
    return;
  }
  const lineIdx = editor.selection.active.line;
  const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
  const loc = new vscode.Location(editor.document.uri, range);
  // Same as gutter breakpoint: goes to vscode.debug.breakpoints → sync GDB via onDidChangeBreakpoints
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(loc)]);
}

async function applySkipArduinoCoreSources(enabled: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("avrStubDebug");
  await cfg.update("skipArduinoCoreSources", enabled, vscode.ConfigurationTarget.Workspace);

  // If session is not running, just refresh UI.
  if (!gdbMiSession) {
    await refreshAvrDebugPanel();
    return;
  }

  // Apply skip directives live in the existing GDB session (no restart).
  // GDB supports "skip delete" to clear all skip entries.
  const folder = await ensureWorkspaceFolder();
  const settings = readSettings();
  const detectedGdbPath = resolveGdbPath(folder, settings);
  const detectedElfPath = resolveElfPath(folder, settings);
  const dynamicSkips = getDynamicSkipCommands(
    detectedGdbPath,
    detectedElfPath,
    folder.uri.fsPath
  );
  const desired = [...coreSkipCommands(), ...dynamicSkips];

  try {
    // Clear all current skip rules, then re-apply desired ones.
    await gdbMiSession.sendConsole("skip delete").catch(() => undefined);
    for (const cmd of desired) {
      await gdbMiSession.sendConsole(cmd).catch(() => undefined);
    }
  } catch {
    // ignore and keep UI responsive
  }

  await refreshAvrDebugPanel();
}

async function applySerialPortSelection(port: string): Promise<void> {
  const v = port.trim().toUpperCase();
  if (!v) {
    return;
  }
  await vscode.workspace
    .getConfiguration("avrStubDebug")
    .update("serialPort", v, vscode.ConfigurationTarget.Workspace);

  if (!gdbMiSession) {
    await refreshAvrDebugPanel();
    return;
  }

  const folder = await ensureWorkspaceFolder();
  // Regenerate gdbinit with the new `target remote \\.\COMx`
  await setupWorkspaceFiles(folder);

  // Apply without fully disposing the MI process.
  try {
    gdbBreakpointSnapshot.clear();
    await gdbMiSession.restartTarget();
    await onDebuggerStopped();
    // Force breakpoint re-sync after the new target remote.
    void syncAllBreakpointsToGdbAsync();
  } catch {
    await refreshAvrDebugPanel();
  }
}

async function handleAvrDebugWebviewMessage(msg: Record<string, unknown>): Promise<void> {
  switch (msg.type) {
    case "ready":
    case "gdbTermReady":
      await refreshAvrDebugPanel();
      break;
    case "start":
      await vscode.commands.executeCommand("avrStubDebug.startDebugSession");
      break;
    case "continue":
      sendGdbCommand("continue");
      break;
    case "pause":
      sendGdbCommand("interrupt");
      break;
    case "next":
      sendGdbCommand("next");
      break;
    case "step":
      sendGdbCommand("step");
      break;
    case "finish":
      sendGdbCommand("finish");
      break;
    case "restart":
      if (gdbMiSession) {
        await gdbMiSession.restartTarget();
        await onDebuggerStopped();
      }
      break;
    case "stop":
      await stopGdbSession();
      break;
    case "refresh":
      await refreshAvrDebugPanel();
      break;
    case "console":
      if (typeof msg.line === "string" && msg.line.trim()) {
        await processGdbConsoleLines([msg.line.trim()]);
      }
      break;
    case "consoleLines":
      if (gdbMiSession && Array.isArray(msg.lines)) {
        const lines = /** @type {unknown[]} */ (msg.lines)
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.replace(/\r$/, "").replace(/\s+$/, ""))
          .filter((s) => s.length > 0);
        if (lines.length === 0) {
          break;
        }
        await processGdbConsoleLines(lines);
      }
      break;
    case "gdbHelp":
      if (gdbMiSession && typeof msg.topic === "string") {
        const topic = msg.topic.trim();
        await executeGdbLineCommand(topic ? `help ${topic}` : "help", true);
      }
      break;
    case "openGdbTerminal":
      await vscode.commands.executeCommand("avrStubDebug.openGdbTerminal");
      break;
    case "setSkipArduinoCoreSources":
      if (typeof msg.value === "boolean") {
        await applySkipArduinoCoreSources(msg.value);
      }
      break;
    case "serialPortsRefresh":
      await refreshAvrDebugPanel();
      break;
    case "serialPortSet":
      if (typeof msg.value === "string" && msg.value.trim()) {
        await applySerialPortSelection(msg.value);
      }
      break;
    case "consoleInterrupt":
      sendGdbCommand("interrupt");
      break;
    case "varSetValue":
      if (
        gdbMiSession &&
        typeof msg.index === "number" &&
        msg.index >= 0 &&
        msg.index < userVariables.length &&
        typeof msg.value === "string"
      ) {
        const v = userVariables[msg.index];
        const val = msg.value.trim();
        if (v && val.length > 0) {
          try {
            await gdbMiSession.sendConsole(`set variable ${v.name} = ${val}`);
            await refreshUserVariablesFromGdb();
            await refreshAvrDebugPanel();
          } catch (e) {
            vscode.window.showErrorMessage(
              `set variable failed: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
      }
      break;
    case "watchAdd":
      if (typeof msg.expr === "string" && msg.expr.trim()) {
        watchExpressions.push({ expr: msg.expr.trim(), value: "..." });
        await refreshWatchFromGdb();
        await refreshAvrDebugPanel();
      }
      break;
    case "varAddFromSelection": {
      const editor = vscode.window.activeTextEditor;
      let text = "";
      if (editor) {
        if (!editor.selection.isEmpty) {
          text = editor.document.getText(editor.selection).trim();
        } else {
          const r = editor.document.getWordRangeAtPosition(editor.selection.active);
          if (r) {
            text = editor.document.getText(r).trim();
          }
        }
      }
      if (text && !userVariables.some((v) => v.name === text)) {
        userVariables.push({ name: text, value: "..." });
        saveUserVariableNames();
        await refreshUserVariablesFromGdb();
        await refreshAvrDebugPanel();
      }
      break;
    }
    case "watchRemove":
      if (typeof msg.index === "number" && msg.index >= 0) {
        watchExpressions.splice(msg.index, 1);
        await refreshAvrDebugPanel();
      }
      break;
    case "varAdd":
      if (typeof msg.name === "string" && msg.name.trim()) {
        const name = msg.name.trim();
        if (!userVariables.some((v) => v.name === name)) {
          userVariables.push({ name, value: "..." });
          saveUserVariableNames();
          await refreshUserVariablesFromGdb();
          await refreshAvrDebugPanel();
        }
      }
      break;
    case "varRemove":
      if (typeof msg.index === "number" && msg.index >= 0) {
        userVariables.splice(msg.index, 1);
        saveUserVariableNames();
        await refreshAvrDebugPanel();
      }
      break;
    default:
      break;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  initExecutionDecorations();
  const saved = context.workspaceState.get<string[]>(USER_VAR_KEYS) ?? [];
  userVariables = saved.map((name) => ({ name, value: "..." }));

  avrDebugView = new AvrDebugWebviewProvider(context.extensionUri, {
    onMessage: (m) => handleAvrDebugWebviewMessage(m)
  });
  avrGdbTerminalView = new AvrGdbTerminalWebviewProvider(context.extensionUri, {
    onMessage: (m) => handleAvrDebugWebviewMessage(m)
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AvrDebugWebviewProvider.viewType, avrDebugView),
    vscode.window.registerWebviewViewProvider(AvrGdbTerminalWebviewProvider.viewType, avrGdbTerminalView)
  );
  const setup = vscode.commands.registerCommand("avrStubDebug.setupWorkspace", async () => {
    try {
      const folder = await ensureWorkspaceFolder();
      await setupWorkspaceFiles(folder);
      vscode.window.showInformationMessage("AVR Stub debug workspace configured (.vscode/launch.json, tasks.json).");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`AVR Stub setup failed: ${message}`);
    }
  });

  const installDebugFlags = vscode.commands.registerCommand("avrStubDebug.installDebugBuildFlags", async () => {
    await installArduinoDebugBuildFlags();
  });

  const removeDebugFlags = vscode.commands.registerCommand("avrStubDebug.removeDebugBuildFlags", async () => {
    await removeArduinoDebugBuildFlags();
  });

  const template = vscode.commands.registerCommand("avrStubDebug.createSketchTemplate", async () => {
    try {
      const folder = await ensureWorkspaceFolder();
      await createSketchTemplate(folder);
      vscode.window.showInformationMessage("Created sketch template: avr_stub_template.ino");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Template creation failed: ${message}`);
    }
  });

  const startSession = vscode.commands.registerCommand("avrStubDebug.startDebugSession", async () => {
    try {
      await startGdbSession();
      vscode.window.showInformationMessage(
        "GDB/MI session + AVR Stub GDB terminal (same serial). Variables refresh on each stop."
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Debug start failed: ${message}`);
    }
  });

  const openGdbTerminal = vscode.commands.registerCommand("avrStubDebug.openGdbTerminal", async () => {
    try {
      // Ensure panel is visible, then open our panel container and focus the terminal webview.
      await vscode.commands.executeCommand("workbench.action.openPanel");
      await vscode.commands.executeCommand("workbench.view.extension.avrStubDebugGdb");
      await vscode.commands.executeCommand("avrStubDebug.gdbTerminal.focus");
    } catch {
      // Fallback: try direct focus command only.
      await vscode.commands.executeCommand("avrStubDebug.gdbTerminal.focus");
    }
  });

  const gdbBreak = vscode.commands.registerCommand("avrStubDebug.break", () => {
    sendGdbCommand("interrupt");
  });

  const gdbContinue = vscode.commands.registerCommand("avrStubDebug.continue", () => {
    sendGdbCommand("continue");
  });

  const gdbRunToNextBreakpoint = vscode.commands.registerCommand("avrStubDebug.runToNextBreakpoint", () => {
    sendGdbCommand("continue");
  });

  const gdbNext = vscode.commands.registerCommand("avrStubDebug.next", () => {
    sendGdbCommand("next");
  });

  const gdbStep = vscode.commands.registerCommand("avrStubDebug.step", () => {
    sendGdbCommand("step");
  });

  const gdbFinish = vscode.commands.registerCommand("avrStubDebug.finish", () => {
    sendGdbCommand("finish");
  });

  const gdbBacktrace = vscode.commands.registerCommand("avrStubDebug.backtrace", () => {
    sendGdbCommand("bt");
  });

  const gdbLocals = vscode.commands.registerCommand("avrStubDebug.locals", () => {
    sendGdbCommand("info locals");
  });

  const gdbPrint = vscode.commands.registerCommand("avrStubDebug.printVariable", async () => {
    const variable = await vscode.window.showInputBox({
      prompt: "Variable or expression to print (e.g. sum, a, myStruct.field)"
    });
    if (!variable) {
      return;
    }
    sendGdbCommand(`print ${variable}`);
  });

  const gdbAddBreakpointHere = vscode.commands.registerCommand("avrStubDebug.breakpointHere", async () => {
    await addBreakpointAtCursor();
  });

  const gdbDeleteAllBreakpoints = vscode.commands.registerCommand("avrStubDebug.deleteAllBreakpoints", async () => {
    if (gdbMiSession) {
      await gdbMiSession.deleteAllBreakpointsCli();
    } else {
      vscode.window.showWarningMessage("No active GDB session.");
    }
    gdbBreakpointSnapshot.clear();
  });

  const addVariableFromSelection = vscode.commands.registerCommand("avrStubDebug.addVariableFromSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    let text = "";
    if (!editor.selection.isEmpty) {
      text = editor.document.getText(editor.selection).trim();
    } else {
      const r = editor.document.getWordRangeAtPosition(editor.selection.active);
      if (r) {
        text = editor.document.getText(r).trim();
      }
    }
    if (!text) {
      vscode.window.showInformationMessage("Select an identifier or text in the editor.");
      return;
    }
    if (!userVariables.some((v) => v.name === text)) {
      userVariables.push({ name: text, value: "..." });
      saveUserVariableNames();
      await refreshUserVariablesFromGdb();
      await refreshAvrDebugPanel();
    }
  });

  const syncBpNow = vscode.commands.registerCommand("avrStubDebug.syncBreakpointsNow", async () => {
    await syncAllBreakpointsToGdbAsync();
    vscode.window.showInformationMessage("Editor breakpoints synced to GDB.");
  });

  const gdbQuit = vscode.commands.registerCommand("avrStubDebug.stopDebugSession", async () => {
    await stopGdbSession();
  });

  const statusStart = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusStart.text = "$(play) AVR Start";
  statusStart.command = "avrStubDebug.startDebugSession";
  statusStart.tooltip = "Start AVR Stub GDB session";
  statusStart.show();

  const statusContinue = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusContinue.text = "$(debug-continue) AVR Continue";
  statusContinue.command = "avrStubDebug.continue";
  statusContinue.tooltip = "Continue execution";
  statusContinue.show();

  const statusBreak = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  statusBreak.text = "$(debug-pause) AVR Break";
  statusBreak.command = "avrStubDebug.break";
  statusBreak.tooltip = "Interrupt execution";
  statusBreak.show();

  const breakpointListener = vscode.debug.onDidChangeBreakpoints(() => {
    scheduleBreakpointSync();
    void refreshAvrDebugPanel();
  });

  const provider = vscode.debug.registerDebugConfigurationProvider("cppdbg", new CppDbgResolveProvider());

  const hoverProvider = vscode.languages.registerHoverProvider(
    [{ language: "cpp" }, { language: "c" }, { language: "arduino" }, { language: "ino" }],
    {
      provideHover: async (document, position) => {
        if (!gdbMiSession || gdbIsRunning) {
          return undefined;
        }
        const r = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!r) {
          return undefined;
        }
        const expr = document.getText(r).trim();
        if (!expr) {
          return undefined;
        }
        try {
          const val = await gdbMiSession.dataEvaluateExpression(expr);
          return new vscode.Hover([
            new vscode.MarkdownString(`**${expr}**`),
            new vscode.MarkdownString("```text\n" + val + "\n```")
          ]);
        } catch {
          return undefined;
        }
      }
    }
  );
  context.subscriptions.push(
    setup,
    installDebugFlags,
    removeDebugFlags,
    template,
    startSession,
    openGdbTerminal,
    breakpointListener,
    syncBpNow,
    gdbBreak,
    gdbContinue,
    gdbRunToNextBreakpoint,
    gdbNext,
    gdbStep,
    gdbFinish,
    gdbBacktrace,
    gdbLocals,
    gdbPrint,
    gdbAddBreakpointHere,
    gdbDeleteAllBreakpoints,
    addVariableFromSelection,
    gdbQuit,
    statusStart,
    statusContinue,
    statusBreak,
    provider,
    hoverProvider
  );
  if (currentExecLineDecoration) {
    context.subscriptions.push(currentExecLineDecoration);
  }
  if (jumpExecLineDecoration) {
    context.subscriptions.push(jumpExecLineDecoration);
  }
}

export function deactivate(): void {
  void gdbMiSession?.dispose();
  gdbMiSession = undefined;
}
