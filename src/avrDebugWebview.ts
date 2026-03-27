import * as vscode from "vscode";

export class AvrDebugWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "avrStubDebug.panel";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: AvrDebugWebviewHandlers
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((msg) => {
      void this.handlers.onMessage(msg);
    });
  }

  postFullUpdate(payload: Record<string, unknown>): void {
    this.view?.webview.postMessage({ type: "full", ...payload });
  }

  private getHtml(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "avrDebug.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "avrDebug.js"));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${css}" rel="stylesheet" />
</head>
<body>
  <div id="status">AVR Debug — session idle</div>
  <div id="panelHint" class="panel-hint"></div>
  <div id="toolbar">
    <button id="btn-start" title="Start GDB session">Start</button>
    <button id="btn-continue" title="Continue">Continue</button>
    <button id="btn-pause" title="Pause / interrupt">Pause</button>
    <button id="btn-next" title="Step over (next)">Next</button>
    <button id="btn-step" title="Step into (step)">Into</button>
    <button id="btn-finish" title="Step out (finish)">Out</button>
    <button id="btn-restart" title="Reconnect stub (disconnect + source gdbinit)">Restart</button>
    <button id="btn-stop" title="Stop GDB session">Stop</button>
    <button id="btn-refresh" title="Refresh views">Refresh</button>
  </div>
  <div class="collapsible open" id="sec-gdb-console">
    <div class="sec-h">GDB COMMANDS</div>
    <div class="sec-b">
      <div class="serial-row">
        <label class="serial-label" for="serialPortSelect">Serial port:</label>
        <select id="serialPortSelect" class="serial-select"></select>
        <button type="button" id="btn-serial-refresh" class="serial-refresh" title="Refresh available COM ports">Refresh</button>
      </div>
      <p class="sec-help">Manual GDB command input. For full transcript/output use <strong>AVR-GDB</strong> in the bottom panel.</p>
      <div class="gdb-help-row">
        <button type="button" id="btn-help" title="Run: help">help</button>
        <button type="button" id="btn-help-break" title="Run: help break">help break</button>
        <button type="button" id="btn-help-define" title="Run: help define">help define</button>
        <button type="button" id="btn-open-gdb-term" title="Open AVR-GDB terminal">Open terminal</button>
      </div>
      <textarea id="gdbCmdArea" class="gdb-area gdb-area-compact" rows="4" spellcheck="false" autocomplete="off" placeholder="GDB commands (multiline → temp file + source)"></textarea>
      <div class="gdb-send-row">
        <button type="button" id="btn-gdb-send">Send to GDB</button>
        <button type="button" id="btn-gdb-clear" title="Clear input box only">Clear input</button>
      </div>
      <details class="gdb-more-help">
        <summary>More: macros, source file</summary>
        <ul class="gdb-more-list">
          <li><code>help</code> / <code>help define</code> — same as avr-gdb.exe.</li>
          <li>Paste a block (<code>define fn</code> … <code>end</code>) and Send — extension runs <code>source &lt;temp&gt;.gdb</code> automatically.</li>
          <li>Or use your own script: <code>source C:/path/commands_debug.gdb</code> (single-line input here).</li>
        </ul>
      </details>
    </div>
  </div>
  <div class="collapsible" id="sec-variables">
    <div class="sec-h">VARIABLES</div>
    <div class="sec-b">
      <p class="sec-help">Symbols or expressions you care about. Values are read from the stopped target (like GDB <code>print</code>). Example: add <code>counter</code>, stop at a breakpoint, then <strong>Refresh</strong> — the value updates after each stop. Click a value to edit (runs <code>set variable</code>).</p>
      <div class="watch-add">
        <input type="text" id="varInput" placeholder="Name or expression (e.g. myVar)" />
        <button id="btn-var-add">Add</button>
        <button id="btn-var-sel" title="From selection/cursor">Sel</button>
      </div>
      <div id="sec-variables-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-watch">
    <div class="sec-h">WATCH</div>
    <div class="sec-b">
      <p class="sec-help">Watch expressions re-evaluated when the program stops. Example: <code>a + b</code>, <code>sum &gt; 10</code>, or <code>myBuf[0]</code>. Use <strong>Add</strong> with an expression, then step — values refresh on each stop.</p>
      <div class="watch-add">
        <input type="text" id="watchInput" placeholder="Expression" />
        <button id="btn-watch-add">Add</button>
      </div>
      <div id="sec-watch-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-stack">
    <div class="sec-h">CALL STACK</div>
    <div class="sec-b">
      <div class="core-filter-tab">
        <label class="core-filter-row">
          <input id="chkSkipArduinoCoreSources" type="checkbox" />
          Filter Arduino core sources (skip wiring/delay)
        </label>
        <div class="core-filter-explain">
          On reduces noise, but <strong>Step Into</strong> may stay in user code (e.g. <code>delay()</code>).
        </div>
      </div>
      <p class="sec-help">Call chain from the current instruction (inner frame first). Example: <code>loop</code> at line 24 → <code>main</code>. Filled when the target is stopped and GDB has stack unwinding info.</p>
      <div id="sec-stack-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-bp">
    <div class="sec-h">BREAKPOINTS</div>
    <div class="sec-b">
      <p class="sec-help">Editor breakpoints in this workspace (sketch sources). When a session is running, they are mirrored to GDB (<code>break</code> / <code>clear</code>). Example: click the gutter on a line, then <strong>Continue</strong> — execution stops there.</p>
      <div id="sec-bp-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-periph">
    <div class="sec-h">PERIPHERALS (ATmega328 I/O)</div>
    <div class="sec-b">
      <p class="sec-help">A small fixed table of ATmega328 port/timer registers read via GDB memory. Example: <code>PORTB</code>, <code>TCNT0</code> — useful to see pins and timers while stepping. Not a full peripheral viewer.</p>
      <div id="sec-periph-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-reg">
    <div class="sec-h">REGISTERS</div>
    <div class="sec-b">
      <p class="sec-help">CPU registers when the target is stopped (MI, no spam in the GDB console). Example: <code>r24</code>/<code>r25</code> often hold return values on AVR.</p>
      <div id="sec-reg-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-mem">
    <div class="sec-h">MEMORY @ $sp</div>
    <div class="sec-b">
      <p class="sec-help">Raw bytes around the stack pointer (<code>$sp</code>) for a quick stack/memory view. Example: inspect local variables that live on the stack. Length is fixed (64 bytes) for a compact snapshot.</p>
      <div id="sec-mem-body"></div>
    </div>
  </div>
  <div class="collapsible" id="sec-asm">
    <div class="sec-h">DISASSEMBLY @ PC</div>
    <div class="sec-b">
      <p class="sec-help">Instructions near the program counter — similar to GDB <code>disassemble /m</code> / MI disassemble. Example: see the exact instruction where you stopped (useful when source lines do not match optimization).</p>
      <div id="sec-asm-body"></div>
    </div>
  </div>
  <script src="${js}"></script>
</body>
</html>`;
  }
}

export type AvrDebugWebviewHandlers = {
  onMessage: (msg: Record<string, unknown>) => Promise<void> | void;
};
