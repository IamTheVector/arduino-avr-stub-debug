import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

const MARKER_BEGIN = "# BEGIN ARV-STUB-DEBUG (arduino-avr-stub-debug)";
const MARKER_END = "# END ARV-STUB-DEBUG";

const DEBUG_BLOCK = `
${MARKER_BEGIN}
# Line mapping for avr-gdb (PlatformIO-style): -Og keeps structure, -g3 rich DWARF.
# GCC applies flags in order; compiler.*.extra_flags is appended after -Os in platform.txt,
# so -Og here overrides size optimization for C/C++/asm translation units.
compiler.cpp.extra_flags=-Og -g3
compiler.c.extra_flags=-Og -g3
compiler.S.extra_flags=-Og -g3
${MARKER_END}
`.trim();

/** Arduino IDE 2.x package path: .../Arduino15/packages/arduino/hardware/avr/<version> */
export function findLatestArduinoAvrHardwarePath(): string | undefined {
  const base = path.join(os.homedir(), "AppData", "Local", "Arduino15", "packages", "arduino", "hardware", "avr");
  if (!fs.existsSync(base)) {
    return undefined;
  }
  const entries = fs.readdirSync(base, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) {
    return undefined;
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return path.join(base, dirs[dirs.length - 1]);
}

function stripMarkedBlock(content: string): string {
  if (!content.includes(MARKER_BEGIN)) {
    return content;
  }
  const start = content.indexOf(MARKER_BEGIN);
  const end = content.indexOf(MARKER_END, start);
  if (end === -1) {
    return content;
  }
  return (content.slice(0, start) + content.slice(end + MARKER_END.length)).replace(/\n{3,}/g, "\n\n");
}

export async function installArduinoDebugBuildFlags(): Promise<void> {
  const dir = findLatestArduinoAvrHardwarePath();
  if (!dir) {
    vscode.window.showErrorMessage(
      "Arduino AVR core not found under Arduino15. Install the AVR core and build at least one sketch."
    );
    return;
  }
  const platformLocal = path.join(dir, "platform.local.txt");
  let existing = "";
  if (fs.existsSync(platformLocal)) {
    existing = fs.readFileSync(platformLocal, "utf8");
  }
  const cleaned = stripMarkedBlock(existing).trimEnd();
  const combined = (cleaned ? cleaned + "\n\n" : "") + DEBUG_BLOCK + "\n";
  fs.writeFileSync(platformLocal, combined, "utf8");
  vscode.window.showInformationMessage(
    `Updated: ${platformLocal}. Close and reopen Arduino IDE, then Verify/Upload again.`
  );
}

export async function removeArduinoDebugBuildFlags(): Promise<void> {
  const dir = findLatestArduinoAvrHardwarePath();
  if (!dir) {
    vscode.window.showErrorMessage("Arduino AVR core not found.");
    return;
  }
  const platformLocal = path.join(dir, "platform.local.txt");
  if (!fs.existsSync(platformLocal)) {
    vscode.window.showInformationMessage("No platform.local.txt to modify.");
    return;
  }
  const content = fs.readFileSync(platformLocal, "utf8");
  if (!content.includes(MARKER_BEGIN)) {
    vscode.window.showInformationMessage("AVR Stub block not found in platform.local.txt.");
    return;
  }
  const cleaned = stripMarkedBlock(content).trim();
  if (cleaned) {
    fs.writeFileSync(platformLocal, cleaned + "\n", "utf8");
  } else {
    fs.unlinkSync(platformLocal);
  }
  vscode.window.showInformationMessage("Debug flags removed. Rebuild the sketch.");
}
