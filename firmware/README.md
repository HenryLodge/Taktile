# firmware/

ESP-IDF (v5.5) project for the Adafruit Metro ESP32-S3. A thin layer: drivers plus a `tk_platform_t` implementation around `core/`. Security logic belongs in `core/`, not here.

- **No radios.** Never initialize Wi-Fi or Bluetooth (I8). The build is minimal (`set(COMPONENTS main)`), so `esp_wifi`, `bt` and `esp_phy` are not even compiled; keep `main`'s `REQUIRES` narrow.
- **Entropy (I11):** `tk_rng_start()` (`main/rng.c`) is the first call in `app_main`, and its first statement is `bootloader_random_enable()`, which is never disabled. All randomness goes through `tk_rng_fill`, which refuses (fail closed) unless the entropy source is on and the startup and continuous health checks (`core/src/tk_rng_health.c`) pass. Never use the ADC: on the S3 the entropy source runs through it.
- **Never burn eFuses.** There is one board; flash encryption, secure boot, NVS encryption, `espefuse.py burn_*` and `idf.py efuse-*` are all off-limits (docs/HARDWARE.md). `sdkconfig.defaults` keeps every such option off.
- GPIO numbers live in `main/tk_pins.h`, mirrored from `docs/HARDWARE.md`.

## Layout

| Path | What |
| --- | --- |
| `components/tk_core`, `components/trezor_crypto` | Wrap `core/src` and `core/third_party` in place (no copied sources) |
| `main/main.c` | `app_main`: entropy on, then the protocol loop (`tk_device_poll`) or the bring-up menu |
| `main/rng.c` | Hardware RNG: entropy source on, startup + continuous health checks, fail closed |
| `main/link.c` | USB-Serial-JTAG link (the board's USB-C port; CDC-ACM to the laptop) |
| `main/platform.c` | `tk_platform_t`. Serial, clock and RNG are real; storage, audio, haptics and buttons are fail-closed stubs until their Day 3–4 tasks. No wallet yet (every flow answers `NO_WALLET`) |
| `main/bringup.c` | Hardware bring-up menu, one numbered step per `docs/HARDWARE.md` bring-up item. Prints with `out()` straight to the USB driver, not `printf`: stdout needs `vfs`, which pulls the UART and PSRAM drivers into the build |
| `partitions.csv` | `nvs` 64 KB, `factory` app 3 MB, `clips` 10 MB (raw clip pack) |
| `sdkconfig.defaults` | Protocol build: console and logs **off**, so USB carries only frames |
| `sdkconfig.bringup` | Bring-up overlay: console and logs on USB for `idf.py monitor` |
| `tools/smoke.py` | Protocol smoke test against the device |

The generated `sdkconfig` is not committed; edit `sdkconfig.defaults` / `sdkconfig.bringup` instead.

## Build and flash

Activate ESP-IDF first. Linux/macOS: `. $IDF_PATH/export.sh`. Windows: the "ESP-IDF PowerShell" shortcut, or in any PowerShell:

```powershell
$env:IDF_TOOLS_PATH = 'C:\Espressif'                               # where the installer put the tools
$env:PATH = "C:\Espressif\tools\idf-python\3.11.2;$env:PATH"       # IDF's Python before any system Python
. C:\Espressif\frameworks\esp-idf-v5.5.6\export.ps1
```

```bash
cd firmware

# Protocol firmware (what the app talks to). No console: use smoke.py, not monitor.
idf.py build
idf.py -p COMx flash
python tools/smoke.py COMx              # IDF's Python (has pyserial); expects ALL PASS

# Bring-up build (separate build dir and sdkconfig, so the two never mix)
idf.py -B build-bringup -D SDKCONFIG=build-bringup/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.bringup" -p COMx flash monitor
```

`COMx` on Windows, `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on macOS. In the monitor, `Ctrl-]` exits.

**First flash of a new board:** Adafruit's factory firmware enumerates as a different USB device (VID 239A) and can't be reset into the bootloader automatically. Hold **BOOT**, tap **RESET**, release **BOOT**; flash to the port that appears (VID 303A). When download mode was entered with the BOOT button, the reset after flashing does **not** start the app (the chip stays in the bootloader, silent): tap **RESET** once, or run `python -m esptool --chip esp32s3 -p COMx --before no_reset --after watchdog_reset read_mac`. From then on, with our firmware running, `idf.py flash` enters the bootloader and restarts the app by itself. If a flash ever fails, BOOT/RESET always works.

**Check the build has no radios:**

```powershell
(Get-Content build\project_description.json -Raw | ConvertFrom-Json).build_components
```

must not list `esp_wifi`, `bt`, `esp_phy`, `esp_coex`, `esp_adc` or `esp_psram`.
