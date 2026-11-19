# sim/

Host simulator: `core/` + a WebSocket server on `ws://localhost:8765` (same frames as USB serial) + keyboard buttons + audio as printed text. Get every flow working here before flashing hardware.

Builds on Linux or WSL (POSIX). On Windows, build and run it inside WSL; a browser on Windows reaches `ws://localhost:8765` through WSL2's localhost forwarding.

```bash
cmake -S sim -B build/sim && cmake --build build/sim && ctest --test-dir build/sim
./build/sim/taktile-sim --contact Alice=<base58 address>
```

## Keys

| Key | Button |
| --- | --- |
| Up / Down arrows | UP / DOWN |
| Enter | OK |
| Backspace | BACK |
| `c` | CONFIRM |
| `r` | REJECT |
| `O` (shift-o) | long-press OK: repeat the announcement |
| `R` (shift-r) | long-press REJECT: cancel the flow |
| `q` | quit (when no flow is running); Ctrl-C twice quits mid-flow |

Keys pressed while a clip is "playing" are discarded, like the device (I6: CONFIRM during the announcement never counts).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--listen ADDR` | `127.0.0.1` | Address to listen on. Keep it local |
| `--port N` | `8765` | WebSocket port |
| `--data DIR` | `./sim-data` | Saved wallet (`wallet`, `pin-fails`), contact book, and the dev seed if used (gitignored) |
| `--clip-ms N` | `300` | How long each clip "plays" |
| `--contact NAME=ADDR` | | Add a contact (base58 or 64 hex), saved to `DIR/contacts`. Repeatable. `CONTACT_ADD` over the link works too (confirm with `c`) |
| `--dev-wallet` | off | Use the INSECURE dev wallet (`DIR/dev-seed`) instead of the key store |
| `--seed-hex HEX` | | INSECURE dev wallet with this 32-byte seed (not saved); implies `--dev-wallet`. `sim/tests/e2e.py` uses it |
| `--pin DDDDDD` | `123456` | Dev wallet PIN (dev wallet only) |
| `--unlocked` | off | Start with the dev wallet unlocked (dev wallet only; signing still needs CONFIRM) |

## Wallet

By default the sim uses core's key store (`core/src/tk_keystore.c`), exactly as the device does: the key lives PIN-encrypted in `DIR/wallet`, created by `SETUP` on the device side of the link (keys as below; AUDIO.md "SETUP"). Before that the banner says `wallet: none (key store; run SETUP)`. The PIN's start digits are private audio, so to script a SETUP (as `sim/tests/e2e.py` does) build with `-DTK_SIM_INSECURE_AUDIO=ON`. Like the device, it counts PIN attempts before checking them, wipes the wallet and contacts after 10 wrong PINs, and locks again after every signature, 5 minutes after an unlock, and when the app disconnects (stricter than the device, which keeps the session when the app just closes the port). Like the device, contacts loaded without a wallet are wiped at start (they can only be left over from an interrupted lockout wipe), so `--contact` needs a wallet: run SETUP first, or use `--dev-wallet`.

## Development wallet: INSECURE

With `--dev-wallet` (or `--seed-hex`), the sim uses a development wallet whose seed is stored **in plaintext** in `DIR/dev-seed`, created from the system RNG on first run. Devnet only; never put real funds on it. The startup banner prints its address (base58) for airdrops. It still follows the main device rules: signing needs an unlocked session plus CONFIRM, and 10 wrong PINs wipe the seed. Unlike the key store it stays unlocked after a signature (the end-to-end test relies on that).

## Audio and secrets (I2)

Public clips are printed as `[EARPIECE] send`, `[EARPIECE] two`, … Clips core marks secret (the three checksum words and every PIN digit value) print only `[EARPIECE] (private)`. Building with `-DTK_SIM_INSECURE_AUDIO=ON` prints their text too, with a warning banner; use it only for development.

Haptics print as `[HAPTIC] tick` etc.

## Security notes

- The server accepts WebSocket connections only from no Origin (non-browser tools) or from `http(s)://localhost` / `127.0.0.1` pages, so other websites open in your browser can't drive the sim.
- One app connection at a time; a new one replaces the old.

## Example session

```
taktile-sim: ws://127.0.0.1:8765  data: sim-data
WARNING: INSECURE development wallet (plaintext seed in <data>/dev-seed). Devnet only.
wallet: 6mmN…zGkw (locked)
contacts: 1
  0. Alice  3jnh…
[SIM] app connected
[EARPIECE] send
[EARPIECE] two
[EARPIECE] point
[EARPIECE] five
[EARPIECE] USDC
[EARPIECE] to
[EARPIECE] A
…
[EARPIECE] checksum
[EARPIECE] (private)
[EARPIECE] (private)
[EARPIECE] (private)
[EARPIECE] enter pin
…
[EARPIECE] press confirm to sign or reject to cancel
[HAPTIC] success (double pulse)
[EARPIECE] signed
```

## Tests

- `test_ws`: WebSocket handshake (RFC 6455 example), Origin check, frame decoding and encoding, base58, keys, clip text.
- `sim_e2e` (`tests/e2e.py`, Python standard library): runs the sim with the vector "device" seed and Alice as a contact, then checks HELLO, GET_PUBKEY, a full signature, an early CONFIRM being ignored, REJECT, cancel, mid-flow `BUSY`, unknown recipient, the Origin check, and that no checksum word is printed.
