# Ready-made example to try

## 1) Test sketch

Create a file `debug_test.ino` in your Arduino project with:

```cpp
#include <Arduino.h>
#include "avr8-stub.h"
#include "app_api.h"

volatile int a = 10;
volatile int b = 20;
volatile int sum = 0;

void setup() {
  Serial.begin(115200);
  debug_init(); // initialize avr-stub
}

void loop() {
  a++;
  b += 2;
  sum = a + b; // <-- set a breakpoint here (marker)

  if (sum % 5 == 0) {
    Serial.println(sum);
  }

  delay(200);
}
```

## 2) Recommended settings

In the workspace `.vscode/settings.json`:

```json
{
  "avrStubDebug.gdbPath": "C:\\avr8-gnu-toolchain\\bin\\avr-gdb.exe",
  "avrStubDebug.elfPath": "${workspaceFolder}/build/sketch.elf",
  "avrStubDebug.serialPort": "COM5",
  "avrStubDebug.baudRate": 115200
}
```

Adjust paths for your PC.

## 3) Commands (exact order)

In the extension folder:

1. `npm install`
2. `npm run build`
3. `npm run package`

In Arduino IDE 2.x:

4. Install `arduino-avr-stub-debug-0.0.2.vsix` (repo root) via **Extensions: Install from VSIX…** (match `version` in `package.json`)
5. Open the sketch project folder
6. Command Palette: `AVR Stub: Setup Debug Workspace`
7. Build and upload the sketch to the target (with avr-stub)
8. Command Palette: `AVR Stub: Start Debug Session`
9. Open the sketch and place the cursor on `sum = a + b;`
10. Run: `AVR Stub: Add Breakpoint Here`
11. Run: `AVR Stub: Continue` (or status bar `AVR Continue`)

## 4) What to verify

- Panel Variables shows `a`, `b`, `sum`
- Step Over (`AVR Stub: Step Over`) and values change
- Continue runs and hits the breakpoint again on the next loop

## 5) Quick troubleshooting

- Won’t connect: check `COM` in `avrStubDebug.serialPort`
- Gray breakpoints: ensure `elfPath` points to the correct ELF
- Won’t stop: ensure `debug_init()` is called in `setup()`
