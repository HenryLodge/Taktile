# Taktile: send, request, stake on Solana without batting an eye (literally)

**A screenless Solana hardware wallet that talks, built for blind and low-vision users, and safe on a laptop you don't trust.**

> Devpost: <https://devpost.com/software/taktile?ref_content=user-portfolio&ref_feature=in_progres>

---

A hardware wallet's last line of defense is a tiny screen showing where your money is really going. Malware on your computer can't fake that screen. But if you're blind, the screen doesn't help you, and you're back to trusting a screen reader on the same laptop the malware lives on.

Taktile replaces the screen with a private earpiece. An ESP32-S3 parses the raw Solana transaction bytes itself and looks the recipient up in **its own** contact book. It then speaks the real amount and recipient into your ear. Nothing is signed until you enter a PIN on its buttons and press CONFIRM. The laptop handles voice input, the UI and broadcasting, and it is treated as hostile from start to finish.

## Architecture

```
 your voice ──► app (browser) ──► server/ ──► ElevenLabs STT · TTS · Agents        [untrusted]
                 │ builds the transaction, broadcasts it to devnet
                 │ USB serial: framed binary protocol, CRC-32
                 ▼
 ESP32-S3:  parse ─► look up recipient ─► speak ─► PIN ─► CONFIRM ─► Ed25519 sign   [trusted]
                 └─► earpiece · haptic motor · six buttons
```

1. **Speak.** `server/` sends the push-to-talk recording to ElevenLabs Speech to Text. A deterministic parser (no LLM in the money path) turns the text into `{amount, token, contact}`, with amounts as exact integers.
2. **Unlock, then build.** The app asks for the PIN first (`UNLOCK`). Only then does it fetch a fresh devnet blockhash, so the transaction doesn't expire while you enter digits.
3. **Checksum.** The app voice speaks three words derived from the message bytes.
4. **The device decides.** It parses the bytes against a strict allowlist, resolves the destination address → name from its own contacts, and announces the result.
5. **Approve by touch.** CONFIRM presses that start during the announcement are dropped. The device returns only a signature.
6. **Broadcast.** The app checks the signature against the bytes it built, sends the transaction and reads out the result.

| Folder | Contents |
| --- | --- |
| `core/` | Portable C11 (no OS headers): transaction parser, contacts, checksums, protocol framing and every on-device flow |
| `firmware/` | Thin ESP-IDF layer: USB serial, I2S audio, debounced buttons, haptics, NVS |
| `sim/` | `core/` on a laptop behind a WebSocket, with keyboard buttons and printed or played audio |
| `app/` | Vite + React + TypeScript; Web Serial or WebSocket transport; keyboard- and screen-reader-first |
| `server/` | Node: ElevenLabs proxy (keeps the key off the browser), plus payment requests as Solana Actions |
| `tools/` | Generators for constants, word tables, test vectors and the audio clip pack |

More: [ARCHITECTURE](docs/ARCHITECTURE.md) · [SERIAL_PROTOCOL](docs/SERIAL_PROTOCOL.md) · [SOLANA](docs/SOLANA.md) · [AUDIO](docs/AUDIO.md) · [HARDWARE](docs/HARDWARE.md)

### Voice commands

| Say | Answered by |
| --- | --- |
| "send 5 USDC to Max", "stake 2 SOL", "unstake", "unstake all" | **Device**: announcement, then PIN + CONFIRM |
| "what is my address" | **Device**: speaks its own 8-word address phrase |
| "who are my contacts" | **Device**: spells the names; only the *count* crosses USB |
| "lock" | **Device**: ends the PIN session |
| "what is my balance", "how much do I have staked", "recent activity" | Laptop (devnet RPC): information only |
| "request 5 USDC from Max", "did Max pay me" | Laptop (`server/`): information only |
| "repeat that", "help", "cancel" | App ("cancel" also stops the device) |

A compromised laptop could lie about your balance, but nothing the laptop answers is ever an input to signing ([command sources](docs/SECURITY_MODEL.md)).

## Security model

- **No host interpretation.** The serial protocol has no field where the laptop could send a name, amount or summary for the device to repeat. Everything announced comes from the raw message bytes.
- **Address → name, never name → address.** A destination that isn't in the device's contact book is "unknown recipient", with three buzzes.
- **Allowlist of four shapes:** a SOL transfer, a USDC `TransferChecked`, a stake with the pinned validator, and an unstake of the device's own stake account. Anything else is rejected. The device must be the fee payer and the only signer, and duplicate keys are rejected.
- **Secrets stay in the earpiece.** The seed, PIN, PIN digits, checksum words and recovery words never cross USB. Before the first sample of any secret clip, firmware forces the speaker amp off.
- **Rotary PIN.** Each of the 6 digits starts at a random value spoken only in your ear, and you step up or down from there, so watching your hands reveals nothing.
- **PIN-encrypted key.** The key is encrypted under PBKDF2-HMAC-SHA256 with 20,000 iterations (2.6 s on the device). Each attempt is counted *before* the PIN is checked, so pulling the plug doesn't reset the count, and 10 failures wipe the wallet. The session locks after every signature, after 5 minutes, on USB unplug and on reboot.
- **Keys made on the device.** Each wallet gets a BIP39 24-word phrase from the hardware RNG. The entropy source is on from the first line of `app_main`, and the RNG must pass startup and continuous health checks. The phrase is spelled letter by letter into the earpiece. SETUP never overwrites an existing wallet.
- **Contacts verified over the phone.** Adding a contact makes the device read out an 8-word (64-bit) phrase for the address. Your friend reads theirs from their own screen, and if the words match, the address is theirs.
- **No radios.** Wi-Fi and Bluetooth are never initialized.

**Limitations:**
- There is no secure element, flash encryption or secure boot. We had one board, and the last two burn eFuses irreversibly, so anyone with a flash dump can guess the PIN offline.
- Closing the app doesn't lock the device.
- There's no withdrawal of deactivated stake yet.
- Your voice goes to ElevenLabs.
- Devnet only.

Full threat model and invariants: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

## Solana

- **On-device parsing.** The device parses legacy messages of up to 1232 bytes itself. It **derives associated token accounts on the device** with `find_program_address`, including its own ed25519 curve check. That check matches the on-chain curve25519-dalek behavior, which differs from web3.js in two edge cases; both are pinned in tests. The USDC source must be the device's own ATA, and the mint and decimals are pinned.
- **Standard keys.** Keys are derived with SLIP-10 Ed25519 at `m/44'/501'/0'/0'`, the same path Phantom and Solflare use.
- **Hijack-proof native staking.** A stake must be exactly CreateAccountWithSeed + Initialize + DelegateStake. The stake account must be `createWithSeed(device, "tk-stake-<n>", Stake)` for n = 0–15, recomputed on the device. It is signed only if staker and withdrawer are both the device, the lockup is all zero and the vote account is the pinned validator. The announced amount includes the 0.00166624 SOL rent-exempt reserve, because that's what really leaves the wallet.
- **Solana Actions / Blinks.** Payment requests are served as standard Actions (`/actions.json`, GET/POST `/api/actions/request/:id`, spec v2.4, devnet CAIP-2 ID).
  - The POST returns an **unsigned** transfer with a random `reference` key appended; the server never signs.
  - Payment is detected with `getSignaturesForAddress(reference)` plus a balance check.
  - The Taktile Pay page is a Blinks client: it verifies that the transaction is exactly the requested payment, then hands it to Solflare.
- **Devnet enforced.** The RPC endpoint is a constant, and the app and server refuse to run unless the genesis hash is devnet's.

| Program / account | Address |
| --- | --- |
| System Program | `11111111111111111111111111111111` |
| SPL Token (Token-2022 is rejected) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| Stake / Stake config | `Stake11111111111111111111111111111111111111` / `StakeConfig11111111111111111111111111111111` |
| Devnet USDC (6 decimals) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Pinned validator (Kiln vote account) | `FwR3PbjS5iyqzLiLugrBqKSa5EKZ4vK9SKs7eQXtT59f` |

We deploy no programs. These IDs are compiled into the firmware as byte arrays generated from `docs/SOLANA.md` (`core/include/tk_solana_consts.h`).

## ElevenLabs

- **Text to Speech, baked into hardware.** Every word the device can say was generated once with `eleven_multilingual_v2`: 369 clips covering prompts, numbers, letters and the 256 checksum words. They are trimmed, normalized and flashed as a CRC-checked 7.94 MB clip pack, so the device talks with no network at all. Single letters came back as "ah" and "buh", so we regenerated them from their spoken names and picked candidates by ear.
- **Text to Speech, live in the app.** A *different* voice (`eleven_flash_v2_5`, low latency) says only the checksum line, results and errors, and waits whenever the device is speaking. You always know which voice is talking.
- **Speech to Text.** Push-to-talk recordings are transcribed with `scribe_v2`. Contact names, "USDC" and "SOL" are sent as keyterms.
- **Agents.** If "send to Jack" matches two contacts, an agent asks *"Jack Miller or Jack Chen?"*. Its only tool is `choose_contact`, the app accepts only an exact candidate, and the agent never sees amounts, tokens or addresses.

The API key lives only in `server/.env`. The server binds to localhost, redacts the key from logs, rate-limits, never retries and caches TTS.

## Hardware

<Photo.>

- **Board:** Adafruit Metro ESP32-S3 (16 MB flash).
- **Earpiece:** UDA1334A I2S DAC with wired earbuds.
- **Speaker:** MAX98357A amp and speaker, for a demo-only speaker mode.
- **Haptics:** DRV2605L driver with a vibration motor.
- **Buttons:** six tactile buttons: UP, DOWN, OK and BACK, plus large CONFIRM and REJECT buttons.

Everything is USB-powered. Wiring is in [docs/HARDWARE.md](docs/HARDWARE.md).

## Engineering notes

- **Blockhash expiry.** A blockhash lives about 60 s. Our first real send took 50 s (announcement, six PIN digits and key derivation) and landed too late. The fix was the `UNLOCK` message: PIN first, then blockhash, then build.
- **Press-ahead.** If a CONFIRM pressed mid-announcement counted, the announcement would be decoration. The button driver tags every press with a clip epoch and drops any press that began while audio was playing.
- **Secret audio leak.** During bring-up, a missing wire on the amp's shutdown pin let earpiece-only clips play out loud. Firmware now forces the amp off before secret audio, and a bring-up test checks that a loud tone is silent.
- **PIN key-derivation cost.** 100,000 PBKDF2 iterations took 13 s per unlock on the device. We measured and settled on 20,000 (2.6 s).
- **Staking pitfalls.** A stake can name a foreign withdrawer or lockup custodian, who could take the SOL later. So the parser checks every field of all three instructions and recomputes the stake account address itself.

## Testing

- `core/` runs under AddressSanitizer + UndefinedBehaviorSanitizer.
- Every decoder of untrusted bytes has a libFuzzer target: the parser, the serial frames and the clip pack.
- Test vectors are generated with pinned `@solana/web3.js` and `@solana/spl-token`, so the app's transactions are byte-for-byte what the parser was tested on. Every vector set includes malicious cases.
- The same `core/` suite also runs on the ESP32-S3 itself.
- The simulator has an end-to-end test, and `app/`, `server/` and `tools/` have unit tests.

Every command is listed in [CLAUDE.md](CLAUDE.md#commands).

## Running it

**No hardware?** The simulator runs the exact same `core/`.

Requirements:
- Node 22.9+ and Chrome or Edge (for Web Serial).
- **Simulator:** WSL or Linux with CMake and clang.
- **Device:** ESP-IDF v5.5 and the board.
- **ElevenLabs (optional):** a key with TTS and STT access; `npm run dev:canned` works without one.

```bash
git clone https://github.com/HenryLodge/Taktile.git && cd Taktile
git config core.hooksPath .githooks

# server: ElevenLabs proxy + payment requests
cp server/.env.example server/.env                     # ELEVENLABS_API_KEY, voice IDs, agent ID
(cd server && npm ci --ignore-scripts && npm run dev)  # or: npm run dev:canned

# app: http://localhost:5173  (npm run demo adds the malware toggle)
(cd app && npm install && npm run dev)

# EITHER the simulator (options: sim/README.md)
cmake -S sim -B build/sim && cmake --build build/sim
./build/sim/taktile-sim --contact Henry=<base58 address>

# OR the device (firmware/README.md; source ESP-IDF's export.sh first)
(cd firmware && idf.py set-target esp32s3 && idf.py build && idf.py -p <PORT> flash)
node tools/gen-audio.mjs && node tools/pack-clips.mjs  # flash tools/out/clips.bin to the clips partition

# devnet SOL + USDC token accounts (USDC itself: faucet.circle.com)
node tools/setup-devnet.mjs --device <device address> --contact Henry=<address> --dry-run
```

Then connect over USB or to the simulator, run SETUP on the device, add a contact, hold Space and say *"send 0.01 SOL to Henry."*

## What's next

- Withdrawing deactivated stake.
- Spanish and other languages. The device's language would change only after a confirmation spoken in both languages.
- NFC tap-to-add contacts.
- An enclosure with tactile markings.
- Token-2022, versioned messages, and mainnet after a third-party audit.

## Credits
- **trezor-crypto** (MIT): BIP39, PBKDF2, HMAC-SHA2 and Ed25519.
