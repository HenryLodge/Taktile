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
- [x] P0 `firmware/`: ESP-IDF project, USB CDC, `tk_platform_t` implementation (serial + clock real; RNG, storage, audio, haptics, buttons are fail-closed stubs replaced by the tasks below; no-wallet stub until Day 5–6)
- [x] P0 `bootloader_random_enable()` early in `app_main`, before any RNG use; never disabled (I11)
- [x] P0 Buttons with debounce; I2S playback of clips from the clip pack (raw `clips` partition, not LittleFS); SPK_EN control
- [x] P0 DRV2605L haptic patterns
- [x] P0 NVS storage (plain NVS, fails closed, never auto-erased); hardware RNG (done with the entropy-source task); trezor-crypto component; Ed25519 sign verified on host (`tools/verify-ed25519.mjs`)
- [x] P0 Same `core/` tests pass on device: `firmware/test_app` + `firmware/tools/device_tests.py`. Checked 2026-11-17: 14/14 PASS, short run (random loops at 1/20) 2.2 min, full run 40 min

## Day 5–6 (Nov 16–17): device flows

- [x] P0 SETUP: BIP39 generation, spelled recovery-word playback with repeat, PIN setup (rotary entry); refused with `WALLET_EXISTS` if a wallet exists (I10)
- [x] P0 PIN unlock, attempt counter persisted before check, wipe at 10
- [x] P0 CONTACT_ADD with spelled name + 8-word address phrase + PIN + CONFIRM (needed for the demo's happy path)
- [x] P0 SIGN_REQUEST end to end on hardware: first devnet SOL transfer signed on the device 2026-11-18 (`firmware/tools/sign_devnet.py`; [explorer](https://explorer.solana.com/tx/6bcnCLCBewbasekiG985a1MDT1eGZnTkT1nG6hQDKVkASNET2H1bSeSBiP7cci38JugqFYXLdrJeoVHtZhhnnCk?cluster=devnet), 0.01 SOL to the user's own devnet wallet). The first try expired the blockhash (50 s from request to signature), so `UNLOCK` (0x04) was added: the PIN comes first, then the blockhash
- [x] P1 Speaker demo mode (device-only toggle): OK + BACK held 3 s, idle only, reboot resets it, the host can't set or see it (2026-11-18)

## Day 5–7 (Nov 16–18): app and server

- [x] P0 `server/`: `/api/stt`, `/api/tts` ElevenLabs proxy; key from `.env`. No dependencies, localhost only, loop limits, TTS cache, canned mode (`server/README.md`). Live probe 2026-11-18: STT `scribe_v2` with keyterms as repeated fields ("Send one USDC to Henry", language `eng`); TTS `eleven_flash_v2_5` with a separate app voice. The key needs only TTS and STT permissions (`models_read` is optional)
- [ ] P0 `app/`: accessible UI, Web Serial + WebSocket transports, push-to-talk, intent parsing ("send N USDC/SOL to NAME")
- [ ] P0 Tx builder with web3.js on devnet; broadcast; explorer link announced
- [ ] P0 App-side checksum spoken via TTS
- [ ] P0 Malware-mode toggle (swaps destination to an attacker ATA) for the demo
- [ ] P0 `tools/setup-devnet.mjs`: airdrop SOL, get devnet USDC to the device wallet (Circle faucet is manual; document the steps), create contacts' ATAs
- [ ] P1 ElevenLabs Agents conversational disambiguation ("Jack Miller or Jack Chen?")
- [ ] P1 "My address phrase" page for the contact's side of enrollment

## Day 8 (Nov 19): hardening, docs

- [ ] P2 Not planned: flash encryption + secure boot. There is one board and both burn eFuses (`docs/HARDWARE.md`); listed as future work in the README
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
