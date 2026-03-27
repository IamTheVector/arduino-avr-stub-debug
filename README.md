# Arduino AVR Stub Debug Extension (Arduino IDE 2.x)

VS Code / Arduino IDE 2.x extension for a PlatformIO-like debug flow with `avr-stub`:

- **A single `avr-gdb` process** (classic `avr-gdb -q -x avr-stub.gdbinit …elf` + `target remote` on the COM port) — **no second GDB** on the serial port.
- **“AVR Debug” panel** (secondary side bar): toolbar, **GDB COMMANDS** (help + compact input), variables, watch, stack, breakpoints, registers, memory, disassembly — same single `avr-gdb` process.
- **“AVR-GDB”** view in the **bottom panel** (next to Terminal / Problems): full **transcript** + prompt-style input (classic console look). Multiline input is written to **`.vscode/avr-stub-temp-commands.gdb`** in the workspace (then `source` — avoids Windows `%TEMP%` path issues) or, with no folder open, a file under `%TEMP%`. You can still run `source C:/path/script.gdb` in one line.
- Firmware in a loop, breakpoints in the editor, sync to GDB, inspect variables
- Controls also from the **status bar** and Command Palette

## Prerequisites

- Arduino IDE 2.x
- **`avr-gdb`** from a **full** AVR 8-bit GNU toolchain (the folder that only has `avr-gcc.exe` / binutils often has **no** GDB). Official packages: [Microchip AVR 8-bit toolchain downloads](https://www.microchip.com/mplab/avr-support/avr-and-arm-toolchains-c-compilers). Point **`avrStubDebug.gdbPath`** at `bin/avr-gdb.exe` (Windows) or `bin/avr-gdb` (Linux/macOS), or add it to PATH.
- **Arduino library:** from [jdolinay/avr_debug](https://github.com/jdolinay/avr_debug), copy only **`arduino/library/avr-debugger`** into your sketchbook **`libraries`** folder (e.g. `Documents/Arduino/libraries/avr-debugger`). This project is **not** installed via Arduino Library Manager.
- Sketch built with debug symbols (ELF available)

**Step-by-step install:** see **`docs/release/INSTALL_AND_RELEASE.md`** (library → Microchip toolchain / `avr-gdb` → VSIX).

### PlatformIO-style build flags (`-Og -g3`)

For more stable line ↔ instruction mapping (like PlatformIO debug mode):

- **Command Palette** → `AVR Stub: Install Debug Build Flags (-Og -g3, PlatformIO-like)`  
  Writes a block into the AVR core’s `platform.local.txt` (latest under `Arduino15`) so **`-Og` overrides `-Os`** for C/C++/asm.
- Then **restart Arduino IDE**, **Verify/Upload** again, and point GDB at the same ELF from the new build.

To remove: `AVR Stub: Remove Debug Build Flags`.

Details: **`docs/PLATFORMIO_PARITY.md`** in the extension source folder (serial avr-stub ≠ OpenOCD `localhost:3333`).

## Basic sketch (same as typical flow)

```cpp
#include <Arduino.h>
#include "avr8-stub.h"
#include "app_api.h"

void setup() {
  debug_init();
}

void loop() {
  // your loop code
}
```

## Install the extension (local)

The **`.vsix` file is not stored in Git** (it is generated). Run the commands below, then install the produced `.vsix`. For sharing with others, attach the `.vsix` to a **GitHub Release** (recommended) instead of committing binaries.

1. From this folder:
   - `npm install`
   - `npm run build`
   - `npm run package`
2. Install the generated `.vsix` in Arduino IDE 2.x (Command Palette → **Install from VSIX**).

**First-time setup on a new PC:** install the **`avr-debugger`** library from GitHub, install **`avr-gdb`** from the Microchip AVR toolchain, then install the `.vsix`. Details: **`docs/release/INSTALL_AND_RELEASE.md`**.

## Workspace setup

1. Open your sketch folder.
2. Open the **AVR Debug** view (Secondary Side Bar) if needed: **View → Appearance → Secondary Side Bar**.
3. **`AVR Stub: Start Debug Session`** regenerates **`.vscode/`** and starts **GDB**; open **AVR-GDB** in the bottom panel for the transcript; use the side bar **GDB COMMANDS** box for quick input if you like.
4. (Optional) **`AVR Stub: Setup Debug Workspace`** — writes `.vscode` files only, without starting GDB.
5. (Optional) `AVR Stub: Create Sketch Template`

## Important settings

In Settings (or `.vscode/settings.json`) set:

- `avrStubDebug.gdbPath` (e.g. `C:\\avr8-gnu-toolchain\\bin\\avr-gdb.exe`)
- `avrStubDebug.elfPath` (real ELF path for your sketch)
- `avrStubDebug.serialPort` (leave empty for auto-detect; examples: `COM12` on Windows, `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on macOS)
- `avrStubDebug.baudRate` (default `115200`)
- `avrStubDebug.skipArduinoCoreSources` (default `false`)  
  If `true`, GDB will `skip file` for Arduino core sources to reduce noise; if you want to step into core code (e.g. `delay()`), keep it `false`.

## Debug flow

1. Build and upload the sketch with `avr-stub`.
2. Run **`AVR Stub: Start Debug Session`**: starts GDB and refreshes the panel (**no `monitor reset`** on the serial stub; see docs). Use the **AVR-GDB** bottom panel for commands and output.
3. Set breakpoints:
   - **Gutter dots in the editor**: synced to GDB (`clear` / `break`) when a session is active
   - Command Palette: `AVR Stub: Add Breakpoint Here` (adds gutter + sync)
   - Manual: `AVR Stub: Sync Editor Breakpoints → GDB` if you need a refresh
4. Settings:
   - `avrStubDebug.syncEditorBreakpoints` (default: on)
   - `avrStubDebug.breakpointSyncInterruptFirst` (try `true` if GDB ignores breakpoints while the target runs)
5. Use controls:
   - Status bar: `AVR Start`, `AVR Continue`, `AVR Break`
   - Command Palette for Step/Print/Backtrace.
6. When the debugger stops at a marker you can:
   - read variables
   - step over / into
   - continue / pause

## Notes

- The extension generates an optional **`cppdbg`** config; the main flow is the **AVR Debug** panel (**GDB CONSOLE** + views).
- Custom GDB commands: **GDB CONSOLE** in the panel (same `avr-gdb` session as the toolbar / MI).
- If the target does not stop, check:
  - sketch includes `debug_init()`
  - correct serial port
  - ELF matches the uploaded firmware

## License

This project is licensed under the **MIT License**. The full text is in the `LICENSE` file in the extension package root (same folder as `package.json`).

## Source repository

- [github.com/IamTheVector/arduino-avr-stub-debug](https://github.com/IamTheVector/arduino-avr-stub-debug)

## Release docs

- `docs/release/INSTALL_AND_RELEASE.md`
- `docs/release/GIT_SPLIT_GUIDE.md`
- `docs/release/VIDEO_SCRIPT_10MIN_IT.md`
