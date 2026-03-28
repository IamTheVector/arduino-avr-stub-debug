/**
 * Builds the extension and writes arduino-avr-stub-debug-<version>.vsix at the repository root
 * (version from package.json). Run: npm run package:release
 *
 * The output .vsix must be committed to Git — it is what end users install (do not gitignore it).
 */
const { readFileSync } = require("fs");
const { execSync } = require("child_process");
const { resolve } = require("path");

const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const v = pkg.version;
const out = resolve(root, `arduino-avr-stub-debug-${v}.vsix`);
execSync(`npx vsce package -o "${out}"`, { cwd: root, stdio: "inherit", shell: true });
