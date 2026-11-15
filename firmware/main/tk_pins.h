// GPIO assignments for the Adafruit Metro ESP32-S3. Mirrors the "Signal plan" table in
// docs/HARDWARE.md: change one, change both. Do not guess pin numbers.
//
// Plain integers (no ESP-IDF headers), so this also compiles on the host. The static asserts at the
// bottom refuse to build with a duplicate pin or one the board or chip already uses.

#ifndef TK_PINS_H
#define TK_PINS_H

// I2S bus, shared by the UDA1334A (earpiece) and the MAX98357A (speaker); one I2S peripheral.
#define TK_PIN_I2S_BCLK 5 // D5
#define TK_PIN_I2S_WS 6   // D6 (LRCLK / WSEL)
#define TK_PIN_I2S_DOUT 7 // D7

// MAX98357A SD. LOW = speaker shut down (earpiece only). Only speaker mode drives it high, and
// never during a secret clip.
#define TK_PIN_SPK_EN 4 // D4

// DRV2605L via STEMMA QT (10k pull-ups on board).
#define TK_PIN_I2C_SDA 47
#define TK_PIN_I2C_SCL 48

// Buttons: to GND, internal pull-up, active low.
#define TK_PIN_BTN_UP 8       // D8
#define TK_PIN_BTN_DOWN 9     // D9
#define TK_PIN_BTN_OK 10      // D10
#define TK_PIN_BTN_BACK 11    // D11
#define TK_PIN_BTN_CONFIRM 12 // D12
#define TK_PIN_BTN_REJECT 2   // D2 (not D13: the on-board LED is on GPIO13)
#define TK_BTN_ACTIVE_LEVEL 0

// On-board red LED "L" (D13). Bring-up blink only.
#define TK_PIN_LED 13

// ---- Compile-time checks ----

#define TK_PIN_BIT(p) (1ULL << (p))

// Every pin above except the LED.
#define TK_PINS_SIGNALS                                                                          \
    (TK_PIN_BIT(TK_PIN_I2S_BCLK) | TK_PIN_BIT(TK_PIN_I2S_WS) | TK_PIN_BIT(TK_PIN_I2S_DOUT) |     \
     TK_PIN_BIT(TK_PIN_SPK_EN) | TK_PIN_BIT(TK_PIN_I2C_SDA) | TK_PIN_BIT(TK_PIN_I2C_SCL) |      \
     TK_PIN_BIT(TK_PIN_BTN_UP) | TK_PIN_BIT(TK_PIN_BTN_DOWN) | TK_PIN_BIT(TK_PIN_BTN_OK) |      \
     TK_PIN_BIT(TK_PIN_BTN_BACK) | TK_PIN_BIT(TK_PIN_BTN_CONFIRM) | TK_PIN_BIT(TK_PIN_BTN_REJECT))

// Same pins added instead of OR-ed: equal to TK_PINS_SIGNALS exactly when no two pins collide.
#define TK_PINS_SIGNALS_SUM                                                                      \
    (TK_PIN_BIT(TK_PIN_I2S_BCLK) + TK_PIN_BIT(TK_PIN_I2S_WS) + TK_PIN_BIT(TK_PIN_I2S_DOUT) +     \
     TK_PIN_BIT(TK_PIN_SPK_EN) + TK_PIN_BIT(TK_PIN_I2C_SDA) + TK_PIN_BIT(TK_PIN_I2C_SCL) +      \
     TK_PIN_BIT(TK_PIN_BTN_UP) + TK_PIN_BIT(TK_PIN_BTN_DOWN) + TK_PIN_BIT(TK_PIN_BTN_OK) +      \
     TK_PIN_BIT(TK_PIN_BTN_BACK) + TK_PIN_BIT(TK_PIN_BTN_CONFIRM) + TK_PIN_BIT(TK_PIN_BTN_REJECT))

// Pins no signal may use (docs/HARDWARE.md): strapping 0/3/45/46, native USB 19/20, flash and
// octal PSRAM 26-37, microSD 21/39/42/45, UART 40/41, debug UART (console) 43/44, NeoPixel 46.
#define TK_PINS_RANGE(lo, hi) (((1ULL << ((hi) - (lo) + 1)) - 1) << (lo))
#define TK_PINS_FORBIDDEN                                                                        \
    (TK_PIN_BIT(0) | TK_PIN_BIT(3) | TK_PIN_BIT(19) | TK_PIN_BIT(20) | TK_PIN_BIT(21) |          \
     TK_PINS_RANGE(26, 37) | TK_PINS_RANGE(39, 46))

_Static_assert(TK_PIN_I2S_BCLK <= 48 && TK_PIN_I2S_WS <= 48 && TK_PIN_I2S_DOUT <= 48 &&
                   TK_PIN_SPK_EN <= 48 && TK_PIN_I2C_SDA <= 48 && TK_PIN_I2C_SCL <= 48 &&
                   TK_PIN_BTN_UP <= 48 && TK_PIN_BTN_DOWN <= 48 && TK_PIN_BTN_OK <= 48 &&
                   TK_PIN_BTN_BACK <= 48 && TK_PIN_BTN_CONFIRM <= 48 && TK_PIN_BTN_REJECT <= 48,
               "tk_pins.h: the ESP32-S3 has GPIO0-48 only");
_Static_assert(TK_PINS_SIGNALS_SUM == TK_PINS_SIGNALS, "tk_pins.h: two signals share a pin");
_Static_assert((TK_PINS_SIGNALS & TK_PINS_FORBIDDEN) == 0,
               "tk_pins.h: a signal is on a strapping, USB, flash/PSRAM or on-board pin");
_Static_assert(TK_PIN_LED == 13 && (TK_PINS_SIGNALS & TK_PIN_BIT(TK_PIN_LED)) == 0,
               "tk_pins.h: GPIO13 is the on-board LED; no signal may use it");

#endif
