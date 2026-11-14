# Architecture

## One-line summary

The laptop proposes a transaction; the device parses it, decides who it's really for, tells the user privately, and signs only after a PIN and a physical press.

## Components

```
            ElevenLabs API        Solana devnet RPC
                  │                      │
┌─────────────────┼──────────────────────┼─────────────────────────────────────┐
│ LAPTOP (untrusted)                                                           │
│  app/ (browser)                          server/ (Node, localhost)           │
│   ├─ Voice UI: push-to-talk, intent      ├─ /api/stt   → ElevenLabs STT      │
│   ├─ Tx builder (@solana/web3.js)        └─ /api/tts   → ElevenLabs TTS      │
│   ├─ App-side checksum phrase (TTS)                                          │
│   ├─ Malware-mode toggle (demo)                                              │
│   └─ Transport: WebSerial | WebSocket(sim)                                   │
└────────────────────────────┬─────────────────────────────────────────────────┘
                             │  USB CDC serial: framed messages (SERIAL_PROTOCOL.md)
┌────────────────────────────┴─────────────────────────────────────────────────┐
│ DEVICE (trusted) — firmware/ + core/                                         │
│   proto → parser → contacts → announce (audio) → PIN/confirm → signer        │
│   Storage: encrypted NVS (seed, PIN verifier, counters), LittleFS (clips)    │
└────────────────────────────┬─────────────────────────────────────────────────┘
                             │
               Earpiece (UDA1334A) · speaker (MAX98357A) · 6 buttons · haptics
```

## Send flow (happy path)

1. User holds push-to-talk and says "send 5 USDC to Jack."
2. `app` sends audio to `server /api/stt`, gets text, parses intent `{amount, token, contactName}`.
3. `app` looks up Jack's wallet in its own (untrusted) contact cache, builds a devnet `TransferChecked` transaction to Jack's USDC associated token account, serializes the **message bytes**.
4. `app` computes its checksum phrase from the message bytes and speaks it via `/api/tts`.
5. `app` sends `SIGN_REQUEST{message}` to the device.
6. Device `core/parser` parses the message (rules in `SOLANA.md`). On failure → `SIGN_REQUEST` response with status `PARSE_UNSUPPORTED`.
7. Device resolves the destination token account against its contact book. Unknown → plays "unknown recipient, do not sign", warning haptic, `SIGN_REQUEST` response with status `UNKNOWN_RECIPIENT`.
8. Device plays: amount, token, recipient name, then checksum phrase — earpiece only.
9. If not unlocked, device runs PIN entry (see `AUDIO.md`).
10. User presses CONFIRM (or REJECT). Device signs with Ed25519 and returns `SIGN_REQUEST` response with status `OK` and the 64-byte signature.
11. `app` attaches the signature, broadcasts to devnet, and announces the result.

## Contact enrollment flow

1. `app` sends `CONTACT_ADD{name, wallet_address}`.
2. Device derives the contact's USDC associated token account itself (see `SOLANA.md`), computes an 8-word address phrase, and plays "Adding <spelled name>. Address phrase: …".
3. User calls the contact; the contact reads the same phrase from their own wallet tool (`app` has a "show my address phrase" page).
4. User confirms with PIN + CONFIRM. Device stores `{name, wallet, usdc_ata}` (`core/contacts`: up to 16; names 1–12 ASCII characters, unique ignoring case; no duplicate wallets).

When signing, a SOL destination is looked up only among contacts' wallets and a USDC destination only among their USDC token accounts; anything else is "unknown recipient".

## Build targets

| Target | Contents | Purpose |
| --- | --- | --- |
| `core` (static lib + tests) | parser, contacts, checksum, ata, flow, proto | All security logic; host-tested with ctest (`-DTK_SANITIZE=ON` for ASan + UBSan) |
| `core` fuzz targets | `fuzz_parser`, `fuzz_frame` (`-DTK_FUZZ=ON`, clang) | libFuzzer on the two untrusted-input decoders, seeded from `tests/vectors/` |
| `sim` | core + WebSocket server on `ws://localhost:8765` + keyboard buttons + audio as printed text (optionally plays clips via `afplay`/`aplay`) | Develop the whole flow before hardware arrives |
| `firmware` | core + ESP-IDF drivers (USB CDC, I2S, GPIO, I2C haptics, NVS, LittleFS) | The real device |
| `app` | Vite + TS | User-facing frontend (required by the Consumer track) |
| `server` | Node + Express | Holds the ElevenLabs key (STT/TTS proxy) |

## Abstractions in core/ that firmware and sim implement

```c
// core/include/tk_platform.h
typedef struct {
    void (*play_clip)(uint16_t clip_id);           // blocking until clip finished
    void (*haptic)(tk_haptic_t pattern);
    tk_button_t (*wait_button)(uint32_t timeout_ms);
    bool (*random_bytes)(uint8_t *out, size_t len); // hardware RNG on device (entropy source enabled at boot, I11)
    bool (*storage_get)(const char *key, void *buf, size_t *len);
    bool (*storage_set)(const char *key, const void *buf, size_t len);
} tk_platform_t;
```

`core/` never calls ESP-IDF or POSIX directly; it only uses this struct. This is what lets the simulator and the firmware share every line of security logic.

## Key third-party pieces

- **trezor-crypto** (from the trezor-firmware repo, MIT) as an ESP-IDF component and a host library: Ed25519, SHA-256, PBKDF2, BIP39, SLIP-10.
- **@solana/web3.js** and **@solana/spl-token** in `app/` and `tools/`.
- **ElevenLabs** Speech-to-Text and Text-to-Speech via `server/`; clip generation in `tools/gen-audio.mjs`.
