# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-03-28

### Changed

- Removed the sidebar **“Filter Arduino core sources”** control; use **`avrStubDebug.skipArduinoCoreSources`** in Settings only (applies on next debug session).
- Removed **`.gitignore` rules** that hid `*.vsix` — the packaged extension at the repo root is a normal tracked file.

### Added

- **`arduino-avr-stub-debug-0.0.2.vsix`** at repository root.

## [0.0.1] - 2026-03-27

### Added

- Committed **`arduino-avr-stub-debug-0.0.1.vsix`** at the repository root for direct install (no `npm` required for end users).
- Initial public release: **Arduino AVR Stub Debug Extension** for Arduino IDE 2.x — AVR stub debugging with `avr-gdb` (MI2), sidebar **AVR Debug** panel, bottom **AVR-GDB** terminal view, breakpoint sync, serial port selection, configurable `skip` for Arduino core sources, GDB path picker, and install documentation.
