# tools/

Build-time scripts (Node).

| Script | Purpose |
| --- | --- |
| `gen-consts.mjs` | Decode pinned base58 constants → `core/include/tk_solana_consts.h` |
| `gen-vectors.mjs` | Build SOL/USDC transactions with web3.js → `tests/vectors/*.json` |
| `gen-audio.mjs` | Generate clips from `clips.json` with ElevenLabs → `tools/out/` (needs `server/.env`) |
| `setup-devnet.mjs` | Airdrop SOL, fund devnet USDC, create contacts' ATAs |

Also planned here: `clips.json`, clip-header generation (`firmware/main/tk_clips.h`), and LittleFS image packing. Listen to every generated clip before packing it: what the device says is trusted output.
