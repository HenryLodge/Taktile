# Hardware

## Parts (full list with sources in the PRD)

- 2 × Adafruit Metro ESP32-S3 (16 MB flash, 8 MB PSRAM) — board #1 for development, board #2 for flash-encryption testing
- Adafruit UDA1334A I2S stereo DAC (3.5 mm jack) + wired earbuds — private earpiece
- Adafruit MAX98357A I2S 3 W amp + small 4–8 Ω speaker — demo speaker mode
- Adafruit DRV2605L haptic driver (STEMMA QT) + vibrating mini motor disc
- 6 × 12 mm tactile buttons (2 large distinct caps for CONFIRM/REJECT)
- Breadboard, jumpers, STEMMA QT cable, USB-C data cables

## Signal plan

**Pin numbers are intentionally not filled in.** Before wiring, a human checks Adafruit's Metro ESP32-S3 pinout page and fills in the `GPIO` column; then mirror it in `firmware/main/tk_pins.h`. Do not guess GPIO numbers.

| Signal | Connects to | GPIO | Notes |
| --- | --- | --- | --- |
| I2S BCLK | UDA1334A BCLK + MAX98357A BCLK | TBD | Shared bus, one I2S peripheral |
| I2S LRCLK / WS | UDA1334A WSEL + MAX98357A LRC | TBD | |
| I2S DOUT | UDA1334A DIN + MAX98357A DIN | TBD | |
| SPK_EN | MAX98357A SD | TBD | Drive LOW = speaker shut down (earpiece-only). Only `speaker mode` drives it high |
| I2C SDA / SCL | DRV2605L via STEMMA QT | Board's STEMMA QT pins | No soldering |
| BTN_UP | button → GND | TBD | Internal pull-up, active low |
| BTN_DOWN | button → GND | TBD | |
| BTN_OK | button → GND | TBD | |
| BTN_BACK | button → GND | TBD | |
| BTN_CONFIRM | button → GND | TBD | |
| BTN_REJECT | button → GND | TBD | |

Power: USB-C from the laptop powers everything. UDA1334A and MAX98357A VIN from the board's 3.3 V or 5 V pin per their Adafruit guides; common ground.

## ESP32-S3 GPIO constraints (avoid these for buttons and I2S)

- Strapping pins: GPIO0, GPIO3, GPIO45, GPIO46
- Native USB: GPIO19, GPIO20 (used for USB CDC to the laptop)
- Octal PSRAM on 8 MB PSRAM modules: GPIO33–37
- Flash/PSRAM SPI pins: GPIO26–32
- Check the Metro's pinout for pins already wired to on-board parts (NeoPixel, LED, STEMMA QT, SD card if present)

## Bring-up order (one test sketch / ESP-IDF example per step)

1. Blink + USB CDC echo: confirm `idf.py monitor` and that the laptop sees the serial device.
2. Entropy: call `bootloader_random_enable()` early in `app_main`, before anything uses randomness, and never disable it (SECURITY_MODEL I11). Without radios this is what makes the hardware RNG truly random.
3. Buttons: print each press with debounce.
4. I2S tone to UDA1334A at 16 kHz; then to speaker with SPK_EN high. Confirm I2S playback works with the entropy source left enabled (ESP-IDF documents conflicts between it and ADC/I2S on some chips; verify on the S3).
5. Play one PCM clip from LittleFS.
6. DRV2605L: play each of the four haptic patterns.
7. NVS read/write with NVS encryption enabled (does not burn eFuses for flash encryption; confirm in ESP-IDF docs before enabling anything).
8. Ed25519 sign a fixed message with trezor-crypto; verify on the laptop with `tweetnacl`.

## Flash encryption and secure boot

**Never enable these without explicit human approval in the chat.** They burn one-time eFuses. Only on board #2, only in Development mode, only after the full demo works on board #1 (target: Nov 19). Record exactly which options were set in this file afterward.

## Enclosure (optional, P2)

A small project box or 3D-printed case with CONFIRM and REJECT on opposite ends, a raised dot on OK, and the earbud jack on the top edge. Judges remember a device that feels like a product.
