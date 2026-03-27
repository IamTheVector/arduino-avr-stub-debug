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

### 3. This extension (VSIX)

**Name in the Extensions list:** *Arduino AVR Stub Debug Extension* (`arduino-avr-stub-debug`).

Install **`arduino-avr-stub-debug-<version>.vsix`** in Arduino IDE 2.x:

- **Command Palette** → **Extensions: Install from VSIX…** → select the `.vsix` file.

After installation, configure **`avrStubDebug.serialPort`** (empty = auto-detect where possible), **`avrStubDebug.elfPath`**, and start a session with **`AVR Stub: Start Debug Session`**.

---

## What is required (summary)

### Firmware library (required)
- **`avr-debugger`** from [jdolinay/avr_debug](https://github.com/jdolinay/avr_debug) — use the folder **`arduino/library/avr-debugger`** only, copied into sketchbook **`libraries`**.
- Alternatively, another compatible avr-stub over serial (advanced).

### Debugger binary (required)
- **`avr-gdb`** from the [Microchip AVR 8-bit toolchain](https://www.microchip.com/mplab/avr-support/avr-and-arm-toolchains-c-compilers) (or another full toolchain that ships `avr-gdb` for AVR).

### IDE extension (required)
- This extension (`arduino-avr-stub-debug`), installed from the `.vsix` as above.

---

## Local build and package

From extension root:

```powershell
npm install
npm run build
npm run package
```

Expected output artifact:

- `arduino-avr-stub-debug-<version>.vsix`

### Why is the `.vsix` not in the Git repository?

The packaged **`.vsix` is a build artifact**, not source code. It is **ignored by Git** (see `.gitignore`) so the repo stays small and diffs stay readable. **Build it locally** with `npm run package`, or publish the file as a **[GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)** asset for download.

Install in Arduino IDE 2.x:

- Command Palette -> `Install from VSIX`

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
- [ ] `npm run package` creates VSIX
- [ ] README updated
- [ ] LICENSE present (MIT)
- [ ] docs in `docs/release/`
- [ ] manual test on at least one AVR board
- [ ] serial auto-detection tested (CLI + fallback)

---

## Repository

Extension source: [github.com/IamTheVector/arduino-avr-stub-debug](https://github.com/IamTheVector/arduino-avr-stub-debug)
