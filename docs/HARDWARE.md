# Hardware

## Parts (full list with sources in the PRD)

- 1 × Adafruit Metro ESP32-S3 (16 MB flash, 8 MB PSRAM). The plan called for a second board for flash-encryption testing; there is no second board, so nothing in this project burns eFuses (see below)
- Adafruit UDA1334A I2S stereo DAC (3.5 mm jack) + wired earbuds — private earpiece
- Adafruit MAX98357A I2S 3 W amp + small 4–8 Ω speaker — demo speaker mode
- Adafruit DRV2605L haptic driver (STEMMA QT) + vibrating mini motor disc
- 6 × 12 mm tactile buttons (2 large distinct caps for CONFIRM/REJECT)
- Breadboard, jumpers, STEMMA QT cable, USB-C data cables

## Signal plan

Filled in by a human and checked on 2026-11-15 against two pin maps that agree with each other: Arduino-ESP32 `variants/adafruit_metro_esp32s3/pins_arduino.h` and CircuitPython `ports/espressif/boards/adafruit_metro_esp32s3/pins.c`. On this board header pin `Dn` is `GPIOn` for D2–D13. `firmware/main/tk_pins.h` mirrors this table: change one, change both. Do not guess GPIO numbers.

| Signal | Connects to | GPIO | Notes |
| --- | --- | --- | --- |
| I2S BCLK | UDA1334A BCLK + MAX98357A BCLK | GPIO5 (D5) | Shared bus, one I2S peripheral |
| I2S LRCLK / WS | UDA1334A WSEL + MAX98357A LRC | GPIO6 (D6) | |
| I2S DOUT | UDA1334A DIN + MAX98357A DIN | GPIO7 (D7) | |
| SPK_EN | MAX98357A SD | GPIO4 (D4) | Drive LOW = speaker shut down (earpiece-only). Only `speaker mode` drives it high. **If this wire is missing, the speaker is always on** (the amp board pulls SD up), so secret audio reaches the speaker; check it with bring-up step 7 |
| I2C SDA / SCL | DRV2605L via STEMMA QT | SDA=GPIO47, SCL=GPIO48 (STEMMA QT) | No soldering |
| BTN_UP | button → GND | GPIO8 (D8) | Internal pull-up, active low |
| BTN_DOWN | button → GND | GPIO9 (D9) | |
| BTN_OK | button → GND | GPIO10 (D10) | |
| BTN_BACK | button → GND | GPIO11 (D11) | |
| BTN_CONFIRM | button → GND | GPIO12 (D12) | |
| BTN_REJECT | button → GND | GPIO2 (D2) | Not D13: GPIO13 drives the on-board LED, which holds the line between LOW and HIGH |

Power: USB-C from the laptop powers everything. UDA1334A and MAX98357A VIN from the board's 3.3 V or 5 V pin per their Adafruit guides; common ground.

## ESP32-S3 GPIO constraints (avoid these for buttons and I2S)

- Strapping pins: GPIO0, GPIO3, GPIO45, GPIO46
- Native USB: GPIO19, GPIO20 (used for USB CDC to the laptop)
- Octal PSRAM on 8 MB PSRAM modules: GPIO33–37
- Flash/PSRAM SPI pins: GPIO26–32
- Pins already wired to on-board parts (below)

## On-board pins on the Metro ESP32-S3 (do not reuse)

| GPIO | On-board use |
| --- | --- |
| 0 | BOOT button (also a strapping pin) |
| 13 | Red LED "L" (D13). `tk_pins.h` uses it only as `TK_PIN_LED` |
| 46 | NeoPixel (also a strapping pin; its power is cut only with the "Neo Pwr" jumper) |
| 21, 39, 42, 45 | microSD: MISO, SCK, MOSI, CS |
| 40, 41 | UART TX, RX (D1, D0) |
| 43, 44 | Debug UART TX, RX ("De-bug" pads); this is UART0, the default ESP-IDF console |
| 47, 48 | I2C SDA, SCL (STEMMA QT), 10 kΩ pull-ups on board; shared with the MAX17048 battery monitor at 0x36 (DRV2605L is 0x5A). STEMMA QT power is not GPIO-gated |

## Bring-up order (one test sketch / ESP-IDF example per step)

1. Blink + USB CDC echo: confirm `idf.py monitor` and that the laptop sees the serial device.
2. Entropy: call `bootloader_random_enable()` early in `app_main`, before anything uses randomness, and never disable it (SECURITY_MODEL I11). Without radios this is what makes the hardware RNG truly random.
3. Buttons: print each press with debounce.
4. I2S tone to UDA1334A at 16 kHz; then to speaker with SPK_EN high. Confirm I2S playback works with the entropy source left enabled (ESP-IDF documents conflicts between it and ADC/I2S on some chips; verify on the S3). Checked 2026-11-16: RNG health check still passes with I2S running. Then bring-up step 7: a loud tone with SPK_EN LOW must be **silent** on the speaker (on 2026-11-16 the SD wire was missing and secret clips played on the speaker until it was connected).
5. Play one PCM clip from the clip pack (a raw `clips` partition with a bounds-checked index; no filesystem, so no new dependency). Bring-up step 6 checks that CONFIRM pressed during a clip never counts (I6).
6. DRV2605L: play each of the four haptic patterns.
7. NVS read/write, **plain NVS**. On the ESP32-S3 NVS encryption cannot be enabled without burning eFuses (the flash-encryption scheme needs flash encryption; the HMAC scheme burns a key into an eFuse on first boot), and with one board we burn none. The seed is still encrypted under the PIN-derived key (I7); that does not defend against a flash dump.
8. Ed25519 sign a fixed message with trezor-crypto; verify on the laptop with Node's built-in `node:crypto` (Ed25519), no extra dependency.

## Flash encryption and secure boot

**Never enable these without explicit human approval in the chat.** They burn one-time eFuses. They were planned for a second board only, in Development mode, after the full demo works on the first; there is no second board, so they are not enabled (see the Day 8 item in `TASKS.md`). If that changes, record exactly which options were set in this file afterward.

## Enclosure (optional, P2)

A small project box or 3D-printed case with CONFIRM and REJECT on opposite ends, a raised dot on OK, and the earbud jack on the top edge. Judges remember a device that feels like a product.
