import * as vscode from "vscode";

/** Bottom panel: GDB output + command line (avr-gdb.exe–like). */
export class AvrGdbTerminalWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "avrStubDebug.gdbTerminal";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: AvrGdbTerminalWebviewHandlers
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

  appendConsole(text: string): void {
    this.view?.webview.postMessage({ type: "term", consoleAppend: text });
  }

  clearConsole(): void {
    this.view?.webview.postMessage({ type: "term", consoleClear: true });
  }

  private getHtml(webview: vscode.Webview): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "gdbTerminal.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "gdbTerminal.js"));
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
  <div class="gdb-term-chrome">
    <span class="gdb-term-title">avr-gdb</span>
    <div class="gdb-term-actions">
      <button type="button" id="btn-help" title="help">help</button>
      <button type="button" id="btn-help-break" title="help break">break</button>
      <button type="button" id="btn-help-define" title="help define">define</button>
      <button type="button" id="btn-term-clear" title="Clear transcript">Clear</button>
    </div>
  </div>
  <div id="termOut" class="gdb-term-out" tabindex="0"></div>
  <div class="gdb-term-input-wrap">
    <span class="gdb-term-prompt" aria-hidden="true">(gdb)</span>
    <textarea id="gdbTermCmd" class="gdb-term-cmd" rows="2" spellcheck="false" autocomplete="off" placeholder="Commands (multiline → temp .gdb + source)"></textarea>
  </div>
  <div class="gdb-term-sendbar">
    <button type="button" id="btn-gdb-send">Send</button>
    <span class="gdb-term-hint">Ctrl+Enter send · Ctrl+C interrupt · Alt+↑↓ history</span>
  </div>
  <script src="${js}"></script>
</body>
</html>`;
  }
}

export type AvrGdbTerminalWebviewHandlers = {
  onMessage: (msg: Record<string, unknown>) => Promise<void> | void;
};
