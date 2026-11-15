# Tasks

Work top-down. P0 = must ship for the demo. P1 = ship if time allows. P2 = README "what we'd build next." Check items off in the commit that completes them. Target dates are from the PRD; deadline is **Fri Nov 20, 12:00 PM CST**.

## Day 1–2 (Nov 12–13): scaffolding and simulator

- [x] P0 Repo skeleton per `CLAUDE.md` layout; `.gitignore` (`.env`, `build/`, `node_modules/`, `*.keypair.json`, `tools/out/`); human runs `git config core.hooksPath .githooks`
- [x] P0 `core/`: CMake library + ctest harness; vendor trezor-crypto (host build)
- [x] P0 `core/proto`: frame encode/decode + CRC-32, with fuzz-style tests on random/truncated input
- [x] P0 `tools/gen-consts.mjs`: decode pinned base58 constants → `tk_solana_consts.h`
- [x] P0 `tools/gen-vectors.mjs`: SOL and USDC transfer vectors + every negative case in `SOLANA.md`
- [x] P0 `core/parser`: legacy message parser, Shapes A and B, all checks; passes all vectors
- [x] P0 `TK_SANITIZE` CMake option (ASan + UBSan) and `core/fuzz/` libFuzzer targets for the parser and frame decoder, seeded from `tests/vectors/`
- [x] P0 `core/ata`: on-device ATA derivation; matches `getAssociatedTokenAddressSync` vectors
- [x] P0 `core/checksum` + `app/src/checksum.ts` with shared vectors
- [x] P0 `core/contacts`: fixed-size table (max 16), lookup by wallet or USDC ATA
- [x] P0 `core/flow`: the sign-request state machine using `tk_platform_t` (announce → PIN → confirm → sign)
- [x] P0 `sim/`: WebSocket server, keyboard buttons (arrows = UP/DOWN, Enter = OK, Backspace = BACK, `c` = CONFIRM, `r` = REJECT), audio printed as `[EARPIECE] …` only with `-DTK_SIM_INSECURE_AUDIO=1`
- [x] P0 `tools/clips.json` + `tools/gen-audio.mjs`; generate all clips

## Day 3–4 (Nov 14–15): hardware bring-up

- [x] P0 Fill in the GPIO column in `HARDWARE.md` (human) and `tk_pins.h`
- [ ] P0 `firmware/`: ESP-IDF project, USB CDC, `tk_platform_t` implementation
- [ ] P0 `bootloader_random_enable()` early in `app_main`, before any RNG use; never disabled (I11)
- [ ] P0 Buttons with debounce; I2S playback of clips from LittleFS; SPK_EN control
- [ ] P0 DRV2605L haptic patterns
- [ ] P0 NVS storage; hardware RNG; trezor-crypto component; Ed25519 sign verified on host
- [ ] P0 Same `core/` tests pass on device (a `test` app target or on-boot self-test)

## Day 5–6 (Nov 16–17): device flows

- [ ] P0 SETUP: BIP39 generation, spelled recovery-word playback with repeat, PIN setup (rotary entry); refused with `WALLET_EXISTS` if a wallet exists (I10)
- [ ] P0 PIN unlock, attempt counter persisted before check, wipe at 10
- [ ] P0 CONTACT_ADD with spelled name + 8-word address phrase + PIN + CONFIRM (needed for the demo's happy path)
- [ ] P0 SIGN_REQUEST end to end on hardware
- [ ] P1 Speaker demo mode (device-only toggle)

## Day 5–7 (Nov 16–18): app and server

- [ ] P0 `server/`: `/api/stt`, `/api/tts` ElevenLabs proxy; key from `.env`
- [ ] P0 `app/`: accessible UI, Web Serial + WebSocket transports, push-to-talk, intent parsing ("send N USDC/SOL to NAME")
- [ ] P0 Tx builder with web3.js on devnet; broadcast; explorer link announced
- [ ] P0 App-side checksum spoken via TTS
- [ ] P0 Malware-mode toggle (swaps destination to an attacker ATA) for the demo
- [ ] P0 `tools/setup-devnet.mjs`: airdrop SOL, get devnet USDC to the device wallet (Circle faucet is manual; document the steps), create contacts' ATAs
- [ ] P1 ElevenLabs Agents conversational disambiguation ("Jack Miller or Jack Chen?")
- [ ] P1 "My address phrase" page for the contact's side of enrollment

## Day 8 (Nov 19): hardening, docs

- [ ] P1 Flash encryption + secure boot on board #2 (Development mode) — **human approval required**
- [ ] P0 README (use `README.md` template): architecture, security model + limits, program IDs, Solana usage, ElevenLabs products used, setup instructions
- [ ] P0 Rehearse the demo script from the PRD three times

## Day 9 (Nov 20, before noon CST): submit

- [ ] P0 Record 2–3 min demo video with audio, device on camera; upload to YouTube or Drive, check link access
- [ ] P0 Devpost submission: Consumer Applications, Best use of Solana, ElevenLabs bounty; all written answers

## P2 (document only)

- Secure element for key storage
- NFC device-to-device contact exchange
- Token-2022, versioned messages, ATA creation in-transaction
- Enclosure with tactile markings
