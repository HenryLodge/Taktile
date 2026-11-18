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
| `main/main.c` | `app_main`: entropy on, speaker off, drivers, then the protocol loop (`tk_device_poll`) or the bring-up menu |
| `main/rng.c` | Hardware RNG: entropy source on, startup + continuous health checks, fail closed |
| `main/buttons.c` | Six buttons: 5 ms scan, 30 ms debounce, 2 s long press for OK and REJECT; presses that start during a clip never count (I6) |
| `main/audio.c` | I2S0 at 16 kHz to the earpiece DAC and speaker amp; `SPK_EN` LOW for every secret clip (#9); clips from the clip pack, checked at boot, silent if it's missing or stale |
| `main/haptics.c` | DRV2605L over I2C (GPIO47/48): ERM motor, four patterns from its effect library; fire-and-forget, off if the chip is missing |
| `main/storage.c` | Plain NVS (namespace `taktile`), same contract as the simulator's storage. Fails closed and never erases the partition by itself |
| `main/link.c` | USB-Serial-JTAG link (the board's USB-C port; CDC-ACM to the laptop) |
| `main/platform.c` | `tk_platform_t`. Serial, clock, RNG, buttons, audio, haptics and storage are real. No wallet yet (every flow answers `NO_WALLET`) |
| `main/bringup.c` | Hardware bring-up menu, one numbered step per `docs/HARDWARE.md` bring-up item. Prints with `out()` straight to the USB driver, not `printf`: stdout needs `vfs`, which pulls the UART and PSRAM drivers into the build |
| `partitions.csv` | `nvs` 64 KB, `factory` app 3 MB, `clips` 10 MB (raw clip pack) |
| `sdkconfig.defaults` | Protocol build: console and logs **off**, so USB carries only frames |
| `sdkconfig.bringup` | Bring-up overlay: console and logs on USB for `idf.py monitor` |
| `tools/smoke.py` | Protocol smoke test against the device |
| `test_app/` | Device test app: every `core/` host test (list in `core/tests/tests.cmake`) built for the ESP32-S3 and run at boot. Never shipped, holds no key |
| `tools/device_tests.py` | Runs the device tests over USB and exits 0 only on PASS |

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
python tools/smoke.py COMx              # IDF's Python (has pyserial); expects ALL PASS (device with no wallet;
                                        #   starts a SETUP and cancels it: you hear "choose a new PIN", then "cancelled")
python tools/smoke.py COMx --setup      # runs SETUP: do it on the device (about 5 min); prints the new address
python tools/smoke.py COMx --wallet     # device with a wallet: state, address, contact count, SETUP refused with WALLET_EXISTS
python tools/smoke.py COMx --contact Alice   # CONTACT_ADD with Alice's public test-vector wallet (or NAME=ADDRESS):
                                        # prints the 8 address-phrase words to listen for; confirm on the device

# Bring-up build (separate build dir and sdkconfig, so the two never mix)
idf.py -B build-bringup -D SDKCONFIG=build-bringup/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.bringup" -p COMx flash monitor

# Clip pack: once, and again whenever the clips change (idf.py flash doesn't touch it)
node ../tools/pack-clips.mjs
python $IDF_PATH/components/partition_table/parttool.py -p COMx --partition-table-file partitions.csv write_partition --partition-name clips --input ../tools/out/clips.bin
```

Without a valid pack every clip is silent; bring-up step 5 prints the pack status.

**NVS** (bring-up step 9 prints its status). If it won't open (for example data left by the board's factory firmware), the firmware never erases it by itself: storage stays off. To erase it yourself, which deletes the wallet and contacts:

```bash
python $IDF_PATH/components/partition_table/parttool.py -p COMx --partition-table-file partitions.csv erase_partition --partition-name nvs
```

**Ed25519 check** (bring-up step 0): copy the `ED25519 …` lines it prints into a file, then `node ../tools/verify-ed25519.mjs that-file.txt` (expects `all 2 signatures OK`).

**Key derivation check** (bring-up step K, menu key `k`): BIP39 and SLIP-10 known answers from `tests/vectors/seed.json` on the device, and the timings of SETUP's BIP39 seed and of the 20,000-iteration unlock KDF. Public test data only; it never reads or writes NVS.

**Unlock check** (bring-up step U, menu key `u`), on a **disposable** wallet only: it runs PIN entry on the device's buttons against the **real** key store and NVS, then prints `unlock: OK`, `WRONG (n left)`, `LOCKED_OUT` or `ERROR` and the stored `pin-fails` (never a PIN digit). It counts like the real thing: the tenth wrong PIN in a row wipes the wallet and the contacts. For the I7 power-cut check, unplug USB while it says "please wait" after a wrong PIN; after replugging, step U must show the attempt counted.

`COMx` on Windows, `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on macOS. In the monitor, `Ctrl-]` exits.

**First flash of a new board:** Adafruit's factory firmware enumerates as a different USB device (VID 239A) and can't be reset into the bootloader automatically. Hold **BOOT**, tap **RESET**, release **BOOT**; flash to the port that appears (VID 303A). When download mode was entered with the BOOT button, the reset after flashing does **not** start the app (the chip stays in the bootloader, silent): tap **RESET** once, or run `python -m esptool --chip esp32s3 -p COMx --before no_reset --after watchdog_reset read_mac`. From then on, with our firmware running, `idf.py flash` enters the bootloader and restarts the app by itself. If a flash ever fails, BOOT/RESET always works.

**Check the build has no radios:**

```powershell
(Get-Content build\project_description.json -Raw | ConvertFrom-Json).build_components
```

must not list `esp_wifi`, `bt`, `esp_phy`, `esp_coex`, `esp_adc` or `esp_psram`.

## Device tests

The same `core/` tests that run under ASan on the host, built for the ESP32-S3 (32-bit `size_t`, Xtensa compiler, trezor-crypto's 32-bit code):

```bash
cd firmware/test_app
idf.py set-target esp32s3                # once
idf.py -p COMx flash                     # replaces the protocol app; same partition table, so clips and NVS are untouched
python ../tools/device_tests.py COMx     # expects "DEVICE TESTS: 17/17 PASS", about 2 min; add --full for ~40 min
cd .. && idf.py -p COMx flash            # put the protocol firmware back
```

The default run is short: the four seeded random loops (`TK_TEST_ITERS` in `core/tests/tk_test.h`) run 1/20 of their host iterations, which is exactly the start of the full run. The long random runs are the host's job (ASan, fuzzers); the device run is for 32-bit and compiler differences. `--full` runs the host's counts (`test_proto` alone takes ~33 min on the device).

Differences from the product build, all limited to the test app: the console is on (the tests print through stdio, so `vfs` is in), the task watchdog is off (long loops that never yield), and the tests' static buffers (about 1.2 MB, mostly `test_proto`'s event logs) are placed in the board's PSRAM by `test_app/main/linker.lf`, because they don't fit in internal RAM. Still no radio or ADC, and the same no-eFuse settings (it layers on `sdkconfig.defaults`).
