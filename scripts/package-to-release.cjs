/**
 * Builds the extension and writes the VSIX under release/arduino-avr-stub-debug-<version>.vsix
 * (version from package.json). Run: npm run package:release
 */
const { readFileSync, mkdirSync } = require("fs");
const { execSync } = require("child_process");
const { resolve } = require("path");

const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const v = pkg.version;
const out = resolve(root, "release", `arduino-avr-stub-debug-${v}.vsix`);
mkdirSync(resolve(root, "release"), { recursive: true });
execSync(`npx vsce package -o "${out}"`, { cwd: root, stdio: "inherit", shell: true });
