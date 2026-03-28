# Install and Release Guide

## End-user installation (three steps)

Follow these steps once per machine. Order matters only for convenience: library and GDB can be installed before or after the extension.

### 1. Arduino library: `avr-debugger` from upstream

**Source (official upstream project):** [jdolinay/avr_debug](https://github.com/jdolinay/avr_debug)

Do **not** rely on Arduino Library Manager for this package; install manually:

1. Open the repository and go to **`arduino/library/avr-debugger`** (that folder is the Arduino library).
2. Copy the entire **`avr-debugger`** folder into your Arduino sketchbook **`libraries`** directory, for example:
   - **Windows:** `Documents\Arduino\libraries\avr-debugger`
   - **macOS / Linux:** `~/Arduino/libraries/avr-debugger`

After copying, Arduino IDE 2.x should list the library under **Sketch → Include Library**.

Your sketch must include the stub headers and call `debug_init()` in `setup()` (see README in this extension).

### 2. `avr-gdb` from the AVR 8-bit GNU toolchain (Microchip)

The folder that contains only `avr-gcc.exe`, `avr-objcopy.exe`, etc. **may not** include the debugger. You need **`avr-gdb`** as a separate binary from a **full** AVR toolchain.

**Official download page:** [Microchip — GCC compilers for AVR (AVR 8-bit toolchain)](https://www.microchip.com/mplab/avr-support/avr-and-arm-toolchains-c-compilers)

1. Download the **AVR 8-Bit Toolchain** archive for your OS (Windows / Linux / macOS) from that page.
2. Extract it. Inside the package, open the **`bin`** directory and locate:
   - **Windows:** `avr-gdb.exe`
   - **Linux / macOS:** `avr-gdb` (executable)
3. Note the **full path** to that file. You may keep the whole extracted toolchain anywhere (e.g. `C:\avr8-gnu-toolchain\bin\avr-gdb.exe`), or copy **only** `avr-gdb` into a folder you prefer (including under your `libraries` tree if you want), as long as the path is stable and readable.

Then set **`avrStubDebug.gdbPath`** in the extension settings to that path (or use the file picker when the extension cannot find GDB).

### 3. This extension (VSIX) — **this is what you install first for the IDE**

The built **`.vsix`** file is **committed in Git** at the **repository root** as **`arduino-avr-stub-debug-<version>.vsix`** (version matches **`package.json`**). You do **not** need Node.js or `npm` to install the extension — only to develop it.

**Name after install (Extensions view):** *Arduino AVR Stub Debug Extension* (`arduino-avr-stub-debug`).

**Install in Arduino IDE 2.x (or VS Code):**

1. Obtain the `.vsix` (clone this repo, download the repo ZIP, or on GitHub download **`arduino-avr-stub-debug-<version>.vsix`** from the repository root).
2. **Command Palette** (`Ctrl+Shift+P` / Windows+Linux, `Cmd+Shift+P` / macOS).
3. Run **Extensions: Install from VSIX…**
4. Pick **`arduino-avr-stub-debug-<version>.vsix`** (from the repo root / ZIP).
5. Reload the window if prompted.

After installation, configure **`avrStubDebug.serialPort`** (empty = auto-detect where possible), **`avrStubDebug.elfPath`**, and start a session with **`AVR Stub: Start Debug Session`**.

Maintainers rebuild the committed VSIX with **`npm run package:release`** at the repo root after version bumps.

---

## What is required (summary)

### Firmware library (required)
- **`avr-debugger`** from [jdolinay/avr_debug](https://github.com/jdolinay/avr_debug) — use the folder **`arduino/library/avr-debugger`** only, copied into sketchbook **`libraries`**.
- Alternatively, another compatible avr-stub over serial (advanced).

### Debugger binary (required)
- **`avr-gdb`** from the [Microchip AVR 8-bit toolchain](https://www.microchip.com/mplab/avr-support/avr-and-arm-toolchains-c-compilers) (or another full toolchain that ships `avr-gdb` for AVR).

### IDE extension (required)
- This extension (`arduino-avr-stub-debug`), installed from **`arduino-avr-stub-debug-<version>.vsix`** at the repo root (see step 3 above).

---

## Repository policy: VSIX must be in Git

The **`.vsix` at the repository root is the primary deliverable** for users (Install from VSIX). It **must** be committed on `master` for every release. **Do not** add `*.vsix` to `.gitignore`. After `npm run package:release`, include the new `arduino-avr-stub-debug-<version>.vsix` in the same commit as `package.json` / `CHANGELOG.md`.

## Maintainer: rebuild the committed VSIX

From the repository root:

```powershell
npm install
npm run package:release
```

This writes **`arduino-avr-stub-debug-<version>.vsix`** at the repository root. Bump **`version`** in `package.json`, rebuild, **commit the `.vsix`**, and push.

---

## Runtime setup

1. Open your sketch folder.
2. Ensure sketch includes:

```cpp
#include <avr8-stub.h>
#include <app_api.h>

void setup() {
  debug_init();
}
```

3. Build/upload sketch with debug symbols (`-Og -g3` recommended).
4. In extension settings:
   - `avrStubDebug.gdbPath`
   - `avrStubDebug.elfPath`
   - `avrStubDebug.serialPort` (empty = auto-detect)
5. Start session: `AVR Stub: Start Debug Session`.

---

## Release checklist

- [ ] `npm run build` passes
- [ ] `npm run package:release` updates **`arduino-avr-stub-debug-<version>.vsix`** at repo root and it is committed
- [ ] README updated
- [ ] LICENSE present (MIT)
- [ ] docs in `docs/release/`
- [ ] manual test on at least one AVR board
- [ ] serial auto-detection tested (CLI + fallback)

---

## Repository

Extension source: [github.com/IamTheVector/arduino-avr-stub-debug](https://github.com/IamTheVector/arduino-avr-stub-debug)
