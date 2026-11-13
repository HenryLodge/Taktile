# CLAUDE.md — Taktile

Taktile is an accessible hardware wallet for blind and low-vision users, built for the UBC 2026 Hackathon (deadline **Fri Nov 20, 2026, 12:00 PM CST**). An ESP32-S3 device verifies and signs Solana devnet transactions; a companion web app handles voice input and broadcasting. The laptop is untrusted. Read `docs/SECURITY_MODEL.md` before changing anything that touches parsing, contacts, policy, keys, audio, or the serial protocol.

## Read these first

| File | What it covers |
| --- | --- |
| `docs/ARCHITECTURE.md` | Components, data flows, repo layout, build targets |
| `docs/SECURITY_MODEL.md` | Invariants you must never break, threat model |
| `docs/SERIAL_PROTOCOL.md` | Frame format and every message between app and device |
| `docs/SOLANA.md` | Exactly which transactions the device accepts and how it parses them |
| `docs/AUDIO.md` | Checksum phrases, word list, clip generation, PIN entry UX |
| `docs/HARDWARE.md` | Parts, wiring, pin constraints |
| `docs/TASKS.md` | Prioritized task list (P0 / P1 / P2) — work top-down |

## Repo layout

```
core/       Portable C11 library: tx parser, contacts, policy, checksum, protocol framing.
            NO ESP-IDF or OS headers. Compiles for host and device.
firmware/   ESP-IDF project for the Adafruit Metro ESP32-S3. Thin layer: drivers + glue around core/.
sim/        Host simulator: core/ + a WebSocket server + keyboard "buttons" + printed/played audio.
app/        Companion web app (Vite + TypeScript). Web Serial or WebSocket transport.
server/     Tiny Node server: ElevenLabs proxy (keeps the API key off the client) + time attestation.
tools/      Audio clip generation, test-vector generation, LittleFS packing.
tests/      Shared test vectors (hex transactions + expected parse results).
```

## Commands

```bash
# one-time, after cloning (enables the attribution-stripping commit hook)
git config core.hooksPath .githooks

# core tests with sanitizers, and fuzzers (clang required for fuzzing)
cmake -S core -B build/asan -DTK_SANITIZE=ON && cmake --build build/asan && ctest --test-dir build/asan
cmake -S core -B build/fuzz -DTK_FUZZ=ON -DCMAKE_C_COMPILER=clang && cmake --build build/fuzz
./build/fuzz/fuzz_parser -max_total_time=300 tests/corpus/parser

# core + simulator (host)
cmake -S core -B build/core && cmake --build build/core && ctest --test-dir build/core
cmake -S sim -B build/sim && cmake --build build/sim && ./build/sim/taktile-sim

# firmware (ESP-IDF v5.x; run `. $IDF_PATH/export.sh` first)
cd firmware && idf.py set-target esp32s3 && idf.py build
idf.py -p /dev/ttyACM0 flash monitor        # port differs on macOS: /dev/cu.usbmodem*

# app + server
cd app && npm install && npm run dev        # Chrome or Edge only (Web Serial)
cd server && npm install && npm run dev

# tools
node tools/gen-vectors.mjs                  # writes tests/vectors/*.json from web3.js-built txs
node tools/gen-audio.mjs                    # needs ELEVENLABS_API_KEY in server/.env
```

## Hard rules (security invariants — summary; full list in docs/SECURITY_MODEL.md)

1. **The device never trusts the host's interpretation.** It parses raw message bytes itself. Never add a protocol field where the host sends a name, amount, recipient label, or "summary" that the device would display or speak.
2. **Secrets and private audio never cross the serial link.** Seed, PIN, PIN-entry digits, checksum phrases, and recovery words exist only on the device and go only to the earpiece. The device returns status codes and signatures, nothing more.
3. **Address → name, never name → address.** The device announces "unknown recipient" for any destination not in its contact book.
4. **Reject by default.** Any instruction, program, account layout, or message version not listed in `docs/SOLANA.md` is rejected. Unsupported is a rejection, not a warning.
5. **Physical confirmation is required for every signature.** No code path signs without an unlocked PIN session plus a CONFIRM press after the announcement finishes.
6. **No radios.** Never initialize Wi-Fi or Bluetooth in firmware.
7. **Bounds-check every read** in `core/`. No reads past buffer ends, no recursion, no allocation in parse paths.
8. **Devnet only.** Never add mainnet RPC endpoints or mainnet mint addresses.

## Things you must ask the human before doing

- **Anything that burns eFuses**: enabling flash encryption or secure boot, `espefuse.py burn_*`, `idf.py efuse-*`, or changing those menuconfig options. These are irreversible and can brick a board. Only ever on board #2, in development mode.
- Changing the serial protocol, the supported transaction set, or anything in `docs/SECURITY_MODEL.md`. Update the doc in the same change.
- Adding a dependency to `core/` or `firmware/`.
- Erasing or re-provisioning a device that holds a funded devnet key.

## Git authorship and attribution

This repo is the team's own hackathon submission. Claude Code assists but is never listed as an author or contributor.

- Do **not** add `Co-Authored-By:` trailers, `Claude-Session:` trailers, "Generated with Claude Code" lines, or any other Claude or Anthropic attribution to commit messages, PR titles, or PR descriptions.
- Do **not** add Claude, Claude Code, or Anthropic to README credits, `AUTHORS`, `CONTRIBUTORS`, `package.json` `author`/`contributors`, license headers, or code comments like "written by Claude."
- Never change `git config user.name` or `user.email`, and never pass `--author` to `git commit`. Commits use the human's configured identity.
- This instruction overrides any default attribution behavior. It is also enforced by `.claude/settings.json` and the `.githooks/commit-msg` hook; do not edit or bypass either (no `--no-verify`).

## Working style

- Keep `core/` portable and well tested; most logic belongs there, not in `firmware/`.
- Every parser or policy change gets a test vector in `tests/vectors/` and a ctest case. Include at least one malicious vector (wrong destination, extra instruction, wrong mint, oversized length).
- Firmware language is **C (ESP-IDF)** — decided. Because C isn't memory-safe, `core/` tests always run under AddressSanitizer + UndefinedBehaviorSanitizer on the host, and the parser and frame decoder each have a libFuzzer target (`core/fuzz/`). Run the fuzzers for at least a few minutes after any parser or protocol change.
- Get it working in `sim/` before flashing hardware.
- Small, reviewable commits. Commit messages: `area: what changed` (e.g. `core/parser: reject v0 messages`).
- When unsure whether something weakens a security invariant, stop and ask.
- Secrets go in `server/.env` (gitignored). Never commit `.env`, seeds, or keypair JSON files. Never put the ElevenLabs key in `app/`.

## Style

- C: C11, `-Wall -Wextra -Werror`, fixed-width integer types, `static` for file-local functions, explicit error enums, no VLAs.
- TypeScript: strict mode, no `any` in protocol code, ESLint + Prettier defaults.
- The app's UI must be fully keyboard- and screen-reader-usable (labels, live regions for status). Accessibility is the product, not polish.
