import * as vscode from "vscode";

/** C/C++/Arduino tokens to exclude from autocomplete (not exhaustive). */
const SKIP = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "goto",
  "void",
  "int",
  "bool",
  "char",
  "short",
  "long",
  "float",
  "double",
  "unsigned",
  "signed",
  "static",
  "const",
  "volatile",
  "extern",
  "inline",
  "struct",
  "class",
  "union",
  "enum",
  "typedef",
  "namespace",
  "template",
  "typename",
  "public",
  "private",
  "protected",
  "virtual",
  "override",
  "true",
  "false",
  "nullptr",
  "NULL",
  "sizeof",
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "int8_t",
  "int16_t",
  "int32_t",
  "int64_t",
  "size_t",
  "byte",
  "boolean",
  "String",
  "HIGH",
  "LOW",
  "INPUT",
  "OUTPUT",
  "INPUT_PULLUP",
  "LED_BUILTIN",
  "Serial",
  "PROGMEM",
  "setup",
  "loop",
  "delay",
  "millis",
  "micros",
  "pinMode",
  "digitalWrite",
  "digitalRead",
  "analogRead",
  "analogWrite",
  "noInterrupts",
  "interrupts",
  "sizeof",
  "this",
  "new",
  "delete",
  "try",
  "catch",
  "throw",
  "using",
  "and",
  "or",
  "not"
]);

const MAX_FILES = 120;
const MAX_SYMBOLS = 500;

/**
 * Heuristic scan: identifiers in workspace source files (for datalist / autocomplete).
 */
export async function scanWorkspaceSymbols(): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return [];
  }
  const globs = ["**/*.ino", "**/*.cpp", "**/*.cc", "**/*.cxx", "**/*.c", "**/*.h", "**/*.hpp"];
  const seen = new Set<string>();
  const scanned = new Set<string>();
  const exclude = "**/{node_modules,.git,out,build,dist}/**";

  for (const pattern of globs) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), exclude, MAX_FILES);
    for (const uri of uris) {
      const key = uri.toString();
      if (scanned.has(key) || scanned.size >= MAX_FILES) {
        continue;
      }
      scanned.add(key);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        collectIdentifiers(text, seen);
      } catch {
        // skip unreadable
      }
    }
  }

  return Array.from(seen)
    .filter((s) => s.length >= 2 && !SKIP.has(s))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, MAX_SYMBOLS);
}

function collectIdentifiers(text: string, out: Set<string>): void {
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]{1,63})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]);
  }
}
