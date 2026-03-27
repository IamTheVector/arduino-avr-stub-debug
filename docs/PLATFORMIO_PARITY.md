# PlatformIO parity vs Arduino IDE + avr-stub

## What is true

| Aspect | PlatformIO | Default Arduino IDE |
|--------|------------|---------------------|
| Optimization | often `-Og` for debug | `-Os` (size) |
| Symbols | `-g3` in debug setup | basic `-g` |
| Line ↔ instruction mapping | much more stable with `-Og -g3` | “skipped” lines / eliminated assignments |

**avr-gdb.exe** is not “weaker” by itself: the main issue is usually an **ELF built with `-Os`** + DWARF that does not match the source on lines inside `if` blocks.

## What not to mix

### avr-stub (serial) ≠ OpenOCD

- **`debug_tool = avr-stub`** in PlatformIO uses **GDB → UART** (`target remote COMx` or similar), **not** `localhost:3333`.
- **OpenOCD** (port 3333) is another transport (debugWire/JTAG/ISP depending on hardware), typically **not** the classic Uno/Mega flow with `avr-debugger` on USB serial.

This project replicates **serial avr-stub + avr-gdb**, like PlatformIO with the stub, **not** the OpenOCD pipeline.

### `monitor reset` in `.gdbinit`

If you see:

`Error in sourced command file: Target does not support this command.`

it is because **`monitor …` is for GDB servers like OpenOCD** (the “monitor” protocol to the debug adapter). **avr-stub on the COM port** only exposes the **remote stub RSP** on serial: it **does not** implement `monitor` commands. The extension **does not** insert `monitor reset` in generated inits (aligned with PlatformIO **avr-stub**, not the OpenOCD `localhost:3333` tutorial).

To reset the board use **physical reset**, **new Upload**, or whatever your sketch supports.

## What the extension adds

Command **`AVR Stub: Install Debug Build Flags (-Og -g3, PlatformIO-like)`**:

- Writes into `Arduino15/packages/arduino/hardware/avr/<version>/platform.local.txt` a marked block that sets:
  - `compiler.cpp.extra_flags=-Og -g3`
  - `compiler.c.extra_flags=-Og -g3`
  - `compiler.S.extra_flags=-Og -g3`

In Arduino `platform.txt`, `extra_flags` is **appended** after `-Os`; **GCC applies the last `-O`**, so `-Og` wins and the code stays more “aligned” with the source.

After installation:

1. **Restart Arduino IDE**
2. **Verify / Upload** again
3. Use the **same** ELF from the new build with `avr-gdb`

Command **`AVR Stub: Remove Debug Build Flags`** only removes the marked block.

## Check in GDB

```gdb
info line Blink_debug_test2.ino:46
disassemble /m loop
```

Addresses consistent with the source → breakpoints on inner lines are much more reliable.
