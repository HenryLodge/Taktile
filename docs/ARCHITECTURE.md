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
│   Storage: plain NVS (PIN-encrypted seed, counters), clip pack (clips)       │
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
| `firmware` | core + ESP-IDF drivers (USB CDC, I2S, GPIO, I2C haptics, NVS, clip pack partition) | The real device |
| `app` | Vite + TS | User-facing frontend (required by the Consumer track) |
| `server` | Node + Express | Holds the ElevenLabs key (STT/TTS proxy) |

## Abstractions in core/ that firmware and sim implement

```c
// core/include/tk_platform.h (every function also takes the platform's ctx pointer)
typedef struct {
    void *ctx;
    void (*play_clip)(void *ctx, uint16_t clip, bool secret);  // blocks until finished; secret = private audio (I2)
    void (*haptic)(void *ctx, tk_haptic_t pattern);
    tk_button_t (*wait_button)(void *ctx, uint32_t timeout_ms); // presses that start during a clip are discarded (I6)
    uint32_t (*now_ms)(void *ctx);
    bool (*random_bytes)(void *ctx, uint8_t *out, size_t len);  // hardware RNG (entropy source enabled at boot, I11)
    bool (*storage_get)(void *ctx, const char *key, void *buf, size_t *len);
    bool (*storage_set)(void *ctx, const char *key, const void *buf, size_t len);
    size_t (*serial_read)(void *ctx, uint8_t *buf, size_t cap); // non-blocking
    void (*serial_write)(void *ctx, const uint8_t *buf, size_t len);
    bool (*audio_ok)(void *ctx);           // clips really play; else flows refuse with DEVICE_ERROR
    bool (*private_audio_only)(void *ctx); // false in speaker mode; SETUP's recovery words need true
} tk_platform_t;

// core/include/tk_wallet.h: the key store as flows see it (core/src/tk_keystore.c implements it)
typedef struct {
    void *ctx;
    bool (*has_wallet)(void *ctx);
    bool (*get_pubkey)(void *ctx, uint8_t out[32]);
    bool (*is_unlocked)(void *ctx);
    tk_unlock_result_t (*unlock)(void *ctx, const uint8_t pin[6], uint8_t *attempts_left);
    bool (*sign)(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[64]); // refuses unless unlocked
    bool (*create)(void *ctx, const uint8_t pin[6], const uint8_t sk[32], const uint8_t pubkey[32]); // SETUP; refuses if a wallet exists (I10)
    void (*lock)(void *ctx); // tk_device_lock: the USB host went away
} tk_wallet_ops_t;
```

`core/` never calls ESP-IDF or POSIX directly; it only uses these structs. This is what lets the simulator and the firmware share every line of security logic.

**Single-threaded request handling** (`core/include/tk_device.h`). The platform's main loop calls `tk_device_poll()` over and over. Core owns the serial protocol: it reads bytes with `serial_read`, decodes frames, and answers. A `SIGN_REQUEST` runs its whole flow (announce → PIN → confirm → sign) inside that call. While the flow runs, core keeps reading the link between clips and between button waits of at most 100 ms, so it can answer `BUSY` and act on `CANCEL` (SERIAL_PROTOCOL.md) without threads or locks. A mid-flow reply waits at most one clip. `tk_device_link_reset()` drops a half-received frame when the link changes (the sim calls it when a WebSocket client connects or disconnects).

**SETUP** (`core/src/tk_setup.c`) is the other on-device flow and runs the same way inside `tk_device_poll()`: PIN and confirmation (rotary entry), entropy from the hardware RNG mixed with the press timing, BIP39 words → seed → SLIP-10 key (`core/src/tk_seed.c`), the 24 words spelled into the earpiece, then `tk_wallet_ops_t.create` (the key store, `core/src/tk_keystore.c`). AUDIO.md "SETUP" has the user's side.

`secret` marks private audio: core sets it for the three checksum words and every PIN digit value. Platforms must never log or print secret clips (the sim prints `(private)` unless built with `TK_SIM_INSECURE_AUDIO`).

## Key third-party pieces

- **trezor-crypto** (from the trezor-firmware repo, MIT) as an ESP-IDF component and a host library: Ed25519, SHA-256, PBKDF2, BIP39, SLIP-10.
- **@solana/web3.js** and **@solana/spl-token** in `app/` and `tools/`.
- **ElevenLabs** Speech-to-Text and Text-to-Speech via `server/`; clip generation in `tools/gen-audio.mjs`.
