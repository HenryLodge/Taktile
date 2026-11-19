# tools/

Build-time scripts (Node 20+).

```bash
cd tools && npm ci --ignore-scripts      # pinned deps from package-lock.json
node --test tools/*.test.mjs             # from the repo root
npm --prefix tools run check             # both generators' --check
```

`--ignore-scripts` skips native add-on builds; web3.js then prints "bigint: Failed to load bindings, pure JS will be used", which is harmless.

| Script | Purpose |
| --- | --- |
| `gen-consts.mjs` | Decode pinned base58 constants → `core/include/tk_solana_consts.h` + `core/src/tk_solana_consts.c` (committed; rerun after changing a constant, `--check` to verify) |
| `gen-words.mjs` | PGP "even" word list (`data/pgp-even-words.txt`) → `core/include/tk_words.h`, `core/src/tk_words.c`, `app/src/words.ts` (committed; `--check` to verify) |
| `gen-vectors.mjs` | Build SOL/USDC messages with web3.js (each parser vector names the exact `tk_parse_result_t` it must produce) → `tests/vectors/{parser,ata,curve,checksum,contacts}.json` + `core/tests/gen/tk_{parser,ata,curve,checksum,contacts}_vectors.h` (committed; `--check` to verify). Offline: builds messages, never calls an RPC |
| `gen-clips.mjs` | Clip text for every ID in `core/include/tk_clips.h` → `tools/clips.json` + `sim/src/clip_text.c` + `core/include/tk_clips_fp.h` (the clip-list fingerprint) (committed; `--check` to verify) |
| `gen-audio.mjs` | Generate clips from `clips.json` with ElevenLabs → `tools/out/clips/<id>.pcm` + `tools/out/preview/*.wav` (gitignored; needs `server/.env`; cached, `--dry-run`, `--only`). See `docs/AUDIO.md` |
| `verify-ed25519.mjs` | Verifies the `ED25519 pub=… msg=… sig=…` lines printed by firmware bring-up step 0 with `node:crypto`; exits 1 on any bad signature or none found |
| `pack-clips.mjs` | `tools/out/clips/<id>.pcm` → `tools/out/clips.bin`, the clip pack for the device's `clips` partition (gitignored; `--check` to verify; flashing in `firmware/README.md`). Refuses clips generated from older text. Format in `docs/AUDIO.md` |
| `setup-agent.mjs` | ElevenLabs Agents setup, safe to rerun: `node --env-file=server/.env tools/setup-agent.mjs [--dry-run]`. Creates the client tool `choose_contact` (reused by name) and the "Taktile disambiguation" agent (or updates it when `ELEVENLABS_AGENT_ID` is set): fixed prompt, signed-token auth, only prompt and first message overridable, the app voice. Prints `ELEVENLABS_AGENT_ID=…` for `server/.env`. The key needs the Agents permission |
| `setup-devnet.mjs` | Devnet demo setup, safe to rerun: `node tools/setup-devnet.mjs --device <addr> --contact Henry=<addr> [--dry-run]`. Creates a setup payer (`tools/out/setup-payer.keypair.json`, gitignored), airdrops SOL to it and the device when under 0.05 SOL, and creates the devnet-USDC token accounts of the device, each contact and the demo attacker (malware mode). Prints balances. Devnet USDC comes from Circle's faucet by hand: https://faucet.circle.com → Solana Devnet → the device address (20 USDC every 2 hours) |

Clip IDs come from `core/include/tk_clips.h`. Listen to every generated clip before packing it: what the device says is trusted output.
