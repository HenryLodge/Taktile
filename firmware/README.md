# firmware/

ESP-IDF project for the Adafruit Metro ESP32-S3. A thin layer: drivers (USB CDC, I2S, GPIO buttons, I2C haptics, NVS, LittleFS) plus a `tk_platform_t` implementation around `core/`. Security logic belongs in `core/`, not here.

- **No radios.** Never initialize Wi-Fi or Bluetooth (I8).
- Call `bootloader_random_enable()` early in `app_main`, before anything uses randomness, and never disable it (I11).
- **Never burn eFuses** (flash encryption, secure boot, `espefuse.py burn_*`, `idf.py efuse-*`) without explicit human approval. Board #2 only, Development mode only.
- GPIO numbers come from `docs/HARDWARE.md`, mirrored in `main/tk_pins.h`. Don't guess them.

```bash
. $IDF_PATH/export.sh
idf.py set-target esp32s3 && idf.py build
idf.py -p <port> flash monitor   # COMx on Windows, /dev/ttyACM0 on Linux, /dev/cu.usbmodem* on macOS
```
