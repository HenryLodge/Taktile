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
| `gen-audio.mjs` | Generate clips from `clips.json` with ElevenLabs → `tools/out/` (needs `server/.env`) |
| `setup-devnet.mjs` | Airdrop SOL, fund devnet USDC, create contacts' ATAs |

Also planned here: `clips.json`, clip-header generation (`firmware/main/tk_clips.h`), and LittleFS image packing. Listen to every generated clip before packing it: what the device says is trusted output.
