# Extra tasks (final feature set)

The final feature set, planned for **Thu Nov 19, 2026** (demo re-recorded tonight; submission **Fri Nov 20, 12:00 PM CST**). Work top-down, same rules as `docs/TASKS.md`: plan first, one branch per part, one milestone at a time, verify on hardware, check the box in the commit that completes it. Every hard rule in `CLAUDE.md` still applies, including attribution.

Parts 1–3 are today's work, in this order. Part 4 (language detection) is at the bottom: do it **only if there is time left** after Part 3 is merged and the demo is re-recorded.

| Order | Part | Branch | Estimate | Security-critical code? |
| --- | --- | --- | --- | --- |
| 1 | Voice commands | `feature/voice-commands` | 3–4 h | Three new protocol messages (0x41–0x43) |
| 2 | Blinks (Solana Actions) | `feature/blinks` | 2–3 h, plus payment requests (D1) | No (server + app) |
| 3 | Staking, one validator | `feature/staking` | 5–7 h | **Yes, `core/parser`** |
| — | *If time:* language detection | `feature/language` | 4–6 h | Firmware audio + two protocol messages (0x44–0x45) |

Parts 1–3 add up to 10–14 h, plus whatever D1 costs. If a part runs long, stop it at a clean milestone and move on; each part is independent of the others except where noted.

## Before starting

- [ ] Merge `app/ui-redesign` into `main`, then tag the rollback point on `main`: `git tag v1-demo-ready && git push origin v1-demo-ready` (Windows, Git Bash, `C:\Taktile`). **The tag does not exist yet**, and every cut line below reverts to it
- [ ] Decide D1–D5 below (each has a recommendation)

### Open decisions

| # | Question | Affects | Recommendation |
| --- | --- | --- | --- |
| D1 | **The payment-request feature this spec builds on is not in the repo.** No inbox, no request flow, no `REQUEST_CONFIRM`, and `docs/private/FEATURE-payment-requests.md` is missing. Blinks serve *payment requests* as Actions, and Part 1 has "request 5 USDC from Max" and "do I have any requests" | Part 1 (two commands), all of Part 2 | Build a minimal app + server version as milestone **R** at the start of Part 2, with no new device message: the app makes a request with the device's own public key (`GET_PUBKEY`) as recipient and a fresh `reference` key; `server/` stores it in memory with an expiry; the inbox page pays it; the app detects payment with `getSignaturesForAddress(reference)`. If you have the original spec somewhere, use it instead. If Part 2 must be cut, drop the two request voice commands with it |
| D2 | `SPEAK_ADDRESS` and `SPEAK_CONTACTS` "require an unlocked session." What happens when the device is locked? | Part 1 V3 | Run PIN entry first, the same way `UNLOCK` does, then speak. This opens the normal session (I7). It is the same answer the user gets from "send", and needs no new status code |
| D3 | The spec says staking is "exempt from send caps," but `SECURITY_MODEL.md` has no caps ("Transaction limits: none") | Part 3 docs | Write it as "staking follows the same rules as a send: PIN session + announcement + CONFIRM; there are no limits to be exempt from" |
| D4 | Shape C has **three** instructions; `SOLANA.md` common check 4 says exactly one | Part 3 S2 | Make it per-shape: Shapes A, B, D need `M == 1`, Shape C needs `M == 3` in the exact order. This is a `SECURITY_MODEL`/`SOLANA.md` change, and the spec approves it. Update both docs in the same commit |
| D5 | Which devnet validator? | Part 3 S1 | You choose from the S0 list. Pick one with a long uptime, recent votes, and a name the TTS can say clearly |

---

## Part 1: Voice commands (`feature/voice-commands`)

**Physically:** nothing until V3. For V3: flash the new firmware **and** the new clip pack together (the pack fingerprint changes), earpiece in.

Each command has a **source**, which decides how far to trust the answer. Anything the laptop says is read-only information and never an input to signing.

| Group | Say | Result | Source |
| --- | --- | --- | --- |
| Money | "send 5 USDC to Max" | Existing send flow | Device verifies |
| Money | "request 5 USDC from Max" / "ask Max for 5 USDC" | Request flow (needs D1) | App + server |
| Money | "stake 2 SOL" / "unstake" / "unstake all" | Part 3 (until then: "Staking isn't available yet.") | Device verifies |
| Info | "what is my balance" / "how much USDC (SOL) do I have" | Balances, spoken by the app | Laptop (RPC) |
| Info | "how much do I have staked" | Staked amount and status (activating, active, deactivating) | Laptop (RPC) |
| Info | "what was my last transaction" / "recent activity" | Last 3 transactions: direction, amount, counterparty name if in the app's contacts | Laptop (RPC) |
| Info | "do I have any requests" / "did Max pay me" | Pending and paid requests (needs D1) | Laptop (app state) |
| Info | "what is my address" | Device speaks its own 8-word address phrase (`SPEAK_ADDRESS`) | **Device** |
| Info | "who are my contacts" | Device spells contact names into the earpiece (`SPEAK_CONTACTS`) | **Device** |
| Control | "lock" / "lock my wallet" | Ends the PIN session (`LOCK`) | Device |
| Control | "repeat that" | App repeats its last line (device repeat stays long-press OK) | App |
| Control | "cancel" / "stop" | Sends `CANCEL`, stops app speech | Both |
| Control | "help" / "what can I say" | Short list of commands, under 20 s | App |

- [x] **V1 intent parser** (`app/src/intent.ts`, `app/src/intent.test.ts`). Extend the `Intent` union with every command above. Filler tolerance: "hey Taktile", "can you", "please", "could you". Still deterministic, no LLM. Tests for each phrasing and for near-misses that must **not** match (e.g. "send" with no amount, "request" with no name, "stake" with USDC → "Only SOL can be staked."). Request and stake intents parse now; their handlers say "not available yet" until Part 2 R / Part 3 S4 wire them
- [x] **V2 read-only queries** (`app/src/rpc.ts` gains `recentSignatures`, `parsedTransaction`, stake-account lookup; a new `app/src/queries.ts`; the send controller routes the intents). Balance (SOL + USDC ATA), staked (check the 16 derived `tk-stake-<n>` addresses with `PublicKey.createWithSeed`, so it works before Part 3 lands and says "Nothing staked"), recent activity (last 3), help, repeat, cancel/stop. Speak through the existing app voice (`speech.ts`), amounts rounded to 2 decimals. Unit tests with a mock `Rpc`
- [ ] **V3 device commands** (protocol change, approved by the spec):
  - `core/include/tk_proto.h`: `0x41 SPEAK_ADDRESS` → `status u8`; `0x42 SPEAK_CONTACTS` → `status u8`, `count u8`; `0x43 LOCK` → `status u8`. Empty payloads (`BAD_PAYLOAD` otherwise). None return names, words or audio
  - `core/src/tk_flow.c`: handlers in `handle_idle`; locked → PIN entry per D2; `SPEAK_ADDRESS` reuses `tk_checksum`'s address phrase for the device's own key (public clips, Q-G); `SPEAK_CONTACTS` spells each stored name with the existing letter clips; `LOCK` calls the wallet's `lock` and is silent-safe when already locked. Same in-flow rules (`BUSY`, `CANCEL`) as the other flows
  - Clips (`core/include/tk_clips.h` → `node tools/gen-clips.mjs` → `node tools/gen-audio.mjs` → listen → `node tools/pack-clips.mjs`): "your address phrase is", "you have", "contacts", "wallet locked". Reuse number clips for the count
  - `core/tests/test_flow.c`: each message, locked and unlocked, `BUSY` mid-flow, `CANCEL`, bad payload; `SPEAK_CONTACTS` reply is exactly 2 bytes
  - `sim/`: works without changes beyond the clip text (`sim/src/clip_text.c` is generated); add the three to `sim/tests/e2e.py`
  - `app/src/proto/codes.ts` + `client.ts`: the three requests; intents call them
  - Docs: `SERIAL_PROTOCOL.md` (three rows), `AUDIO.md` (clips; 359 → 363), `SECURITY_MODEL.md` (trusted vs. untrusted command sources)
- [ ] **Verify:** each command end to end in the sim, then on the device; `SPEAK_CONTACTS` returns only a count (check the raw frames in the app's log); "lock" then "send" asks for the PIN; `cmake` ASan build + ctest clean (WSL, `/mnt/c/Taktile`); `npm test && npm run check` (Windows, `C:\Taktile\app`)

---

## Part 2: Blinks / Solana Actions (`feature/blinks`)

**Physically:** nothing (no firmware change). Phantom or Solflare in the browser, set to devnet, with a funded devnet payer wallet.

Taktile serves each payment request as a **Solana Action** (the API behind Blinks), and the Taktile Pay Inbox is a **Blinks client**. We do **not** claim Phantom or Solflare render these natively: wallet-native rendering only shows registry-verified actions on X.com, not unregistered devnet ones.

- [ ] **R payment requests (only if D1 = build it).** Minimal and devnet-only: app creates `{id, requester pubkey, amount, token, reference, expiresAt}`; `server/` keeps requests in memory (`POST/GET /api/requests`), localhost rules unchanged; Pay Inbox page renders a request and pays it; app polls `getSignaturesForAddress(reference)` and marks it paid. Wire Part 1's "request…" and "do I have any requests / did Max pay me" intents. Tests: request lifecycle, expiry, paid detection with a mock RPC
- [ ] **B0 verification spike (30 min, no code; report and stop).** Against the current Solana Actions spec and `@solana/actions`: `actions.json` format; GET shape (`type`, `icon`, `title`, `description`, `label`, `links.actions`); POST `{ account }` → `{ transaction, message }`; CORS headers, action version and blockchain-ID headers incl. the devnet ID; whether the package works with `@solana/web3.js` 1.98.4. `server/` has no dependencies, so the default is to write the headers and shapes by hand
- [ ] **B1 Actions endpoints in `server/`.** `GET /actions.json` mapping `/request/*` → `/api/actions/request/*`. `GET /api/actions/request/:id`: title "Payment request from <requester>", amount and token in the description, one action "Pay <amount> <token>"; 404 if expired or paid. `POST` with `{ account }`: the same transfer the inbox builds (`TransferChecked` for USDC, System transfer for SOL, to the requester, `reference` appended as a read-only non-signer), payer = `account`, fresh devnet blockhash, unsigned, base64. CORS + action headers on every response incl. `OPTIONS`. **The server never signs.** Only devnet (I9). Add web3.js to `server/` only if B0 says it's needed (it has none today; ask first). Tests in `server/server.test.mjs`
- [ ] **B2 inbox as a Blinks client.** Replace the inbox's own builder with: Action GET → render title, description and button → POST the connected wallet's address → deserialize → sign and send with the injected provider (`window.phantom.solana` or Solflare's). No Phantom Connect SDK. Keyboard and screen-reader usable, status in a live region
- [ ] **B3 shareable Blink URL.** `solana-action:https://<host>/api/actions/request/<id>` per request, shown with a copy button. Document exposing `server/` over a tunnel (Cloudflare Tunnel or ngrok) in `server/README.md`; the demo uses localhost and doesn't need it. Note: the tunnel makes `server/` public, so the Actions routes must be the only ones it exposes (the STT/TTS routes keep their localhost check)
- [ ] **Verify:** the inbox pays a request through the Action round trip; the explorer shows the `reference` key; payment detection fires; an expired request's Action returns 404

README wording: *"Taktile serves payment requests as standard Solana Actions, the protocol behind Blinks, and the Taktile Pay Inbox is a Blinks client. Any Actions-compatible client can pay a Taktile request."*

---

## Part 3: Staking, one validator (`feature/staking`)

**Physically:** flash firmware + clip pack together at S3. After S5, **stake a small amount right away**: devnet stake activates at the next epoch boundary, and judging needs an active stake to show.

Design: one validator pinned at build time in `tools/validator.json` (`{ name, voteAccount }`), compiled into firmware, chosen and approved by you (D5). Stake accounts are derived with `createAccountWithSeed` (base = device wallet, owner = Stake program, seed `tk-stake-<n>`, n = 0–15), so the device stays the only signer and recognizes its own accounts. Out of scope: withdraw after cooldown, liquid staking, split/merge, staking USDC.

**The critical check (never cut it):** reject unless staker **and** withdrawer are both the device key and the lockup is entirely empty. Otherwise a malicious host can stake with an attacker as withdrawer or lockup custodian and take the SOL later.

- [ ] **S0 verification spike (45 min, no code; report and stop).** With web3.js 1.98.4: build stake-and-delegate and deactivate, serialize the legacy messages, record exact instruction order, account lists and data layouts. Confirm Stake program, stake config, rent, clock and stake-history IDs (does DelegateStake still take the config account?). Does `createAccountWithSeed` emit 2 or 3 accounts when base = funder? Fetch devnet vote accounts (for D5), epoch length, minimum delegation, rent-exempt minimum for 200 bytes
- [ ] **S1 constants, validator, vectors.**
  - IDs in `tools/gen-consts.mjs` → `tk_solana_consts.{h,c}`; generated validator header from `tools/validator.json`
  - Clips: "stake", "with", "unstake", "stake account", the validator name, "unknown validator do not sign"
  - `tools/gen-vectors.mjs` positives: stake 1 SOL with seed 0 and 1; deactivate each
  - **Negatives, all rejected:** withdrawer ≠ device; staker ≠ device; custodian set; lockup epoch or timestamp ≠ 0; vote ≠ pinned validator; created address ≠ `SHA256(base ‖ seed ‖ owner)`; seed outside `tk-stake-0..15`; owner ≠ Stake program; space ≠ 200; base or funder ≠ device; instructions reordered, missing or extra; DelegateStake authority ≠ device or stake account mismatch; wrong sysvar or config ID; deactivate on a non-derived account; truncation at every new field
- [ ] **S2 parser: Shapes C and D** (`core/src/tk_parser.c`, `tk_parser.h` new reasons and kinds, `test_parser.c`). All common checks still apply (D4 for the instruction count).
  - Shape C, exactly 3 in order: (1) System CreateAccountWithSeed: funder = base = device, valid seed, owner = Stake, space = 200, address recomputed and matched, lamports recorded; (2) Stake Initialize: same account, **staker = withdrawer = device, lockup 0/0/zero custodian**, rent sysvar pinned; (3) DelegateStake: same account, vote = pinned validator, sysvars and config per S0, authority = device
  - Shape D, exactly 1: Stake Deactivate on an account derivable as `tk-stake-<n>`, clock sysvar pinned, authority = device
  - Docs in the same commit: `SOLANA.md` (Shapes C and D, check order, new reasons), `SECURITY_MODEL.md` (I4 allowlist, authority checks, D3 wording)
- [ ] **S2 verify:** all vectors pass; existing send vectors unchanged; ASan/UBSan ctest clean; `fuzz_parser` for **at least 10 minutes** with the new vectors in the corpus, no findings (WSL, `/mnt/c/Taktile`)
- [ ] **S3 device flow** (`core/src/tk_flow.c` announce + `tk_speech.c`). "Stake <amount> SOL with <validator>. Stake account <n>." (the amount includes the rent-exempt reserve; say so in the README) and "Unstake stake account <n>." Same session, announcement and CONFIRM rules as a send (I5, I6). Wrong validator → warning haptic, "unknown validator, do not sign", `PARSE_UNSUPPORTED`. `test_flow.c` cases; sim first, then device
- [ ] **S4 app** (`app/src/tx.ts`, tests byte-equal to the S1 vectors). "stake N SOL" builds Shape C with the lowest unused seed index plus the rent-exempt minimum; "unstake" builds Shape D (asks which if more than one is active); "unstake all" signs one Shape D per active account, each confirmed on the device; "stake USDC" → "Only SOL can be staked." Wire Part 1's stake intents and "how much do I have staked"
- [ ] **S5 end to end on devnet:** stake, ask status by voice, unstake. Optional demo beat: malware mode swaps the withdrawer and the device refuses (`app/src/malware.ts`, demo builds only)

**Cut line:** if S2 isn't solid with every negative vector passing, stop, revert to `v1-demo-ready`, and pitch staking as future work.

---

## Docs to update as each part lands

- `docs/SERIAL_PROTOCOL.md`: every new message (0x41–0x43; 0x44–0x45 if Part 4)
- `docs/SOLANA.md`: Shapes C and D
- `docs/SECURITY_MODEL.md`: trusted vs. untrusted command sources (Part 1), staking authority checks (Part 3), device language as a protected setting (Part 4)
- `docs/AUDIO.md`: new clips and counts; language packs and checksum words staying English (Part 4)
- `README.md`: voice commands with their sources; "How we use Solana" (Actions, Stake program and its IDs); "How we use ElevenLabs" (STT language detection and Spanish clips, if Part 4)
- This file: check off

Still open in `docs/TASKS.md` today and tomorrow morning: README, demo rehearsal (×3), demo video, Devpost.

---

## Only if there is time: Part 4, language detection (`feature/language`)

Start this only after Parts 1–3 are merged and the demo is re-recorded.

**Physically:** if L0 grows the clip area, reflash the partition table. Before flashing, check that the `nvs` partition keeps the same offset and size: that partition holds the funded demo wallet and the contacts. Then flash firmware and both packs.

Design: English and Spanish now, extendable later. The app follows the detected language freely (intents, app speech, the app's checksum line). **The device language never switches silently:** only `SET_LANGUAGE`, which plays "Switch to Spanish? Press CONFIRM" in **both** languages and needs an unlocked session plus CONFIRM; the app asks out loud first. Checksum words stay English in every language (PGP list distinctness, and app and device must match); document it as a known limitation.

- [ ] **L0 spike (30 min, no code; report and stop).** How ElevenLabs STT (`scribe_v2`) returns the language and its confidence. Note: `server/lib/stt.mjs` currently forces `language_code=en` and replies `{ text }` only; detection means dropping that and returning the language, and English accuracy must be rechecked. A multilingual voice for Spanish clips. **Flash budget:** the English pack is ~7.5 MB of the 10 MB `clips` partition; the board has 16 MB and the partitions end at 0xD20000, so ~2.9 MB is unused. A Spanish pack needs only the non-checksum clips (~107), so it may fit uncompressed by growing `clips`; measure it. If it doesn't, plan IMA ADPCM (4:1) and estimate decode cost
- [ ] **L1 Spanish clip pack.** `tools/clips.es.json` (every prompt, letters, numbers; not the checksum words); pack format gains a language ID; firmware picks the pack by the stored language. Spanish number speech in `core/src/tk_speech.c` ("veintiuno", "cien" vs. "ciento", …) with tests
- [ ] **L2 device setting.** Language in NVS, default English. `0x44 GET_LANGUAGE` → `lang u8`; `0x45 SET_LANGUAGE` (`lang u8`) → `status u8`, with the both-languages confirm flow. Not asked during SETUP in this build (the demo wallet already exists and SETUP never overwrites it, I10); note that as future work
- [ ] **L3 app.** Read the detected language; Spanish intents for every Part 1 command ("envía 5 USDC a Max", "pide 5 USDC a Max", "¿cuál es mi saldo?", "¿cuánto tengo en staking?", "bloquear"); app speech in the detected language; on mismatch, "I heard Spanish. Switch the device to Spanish?" then `SET_LANGUAGE` on yes
- [ ] **Verify:** a Spanish command is detected and parsed; the app asks before switching; the device confirms in both languages; afterwards every device announcement is Spanish except the checksum words; English still works

**Cut line:** if the flash budget forces ADPCM and decoding isn't working by L1, ship the app side only (Spanish commands and app speech, device stays English) and document device Spanish as future work.
