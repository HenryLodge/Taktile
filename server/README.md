# server/

Tiny localhost proxy for ElevenLabs Speech-to-Text and Text-to-Speech, so the API key never reaches the browser, plus the payment-request store (devnet only). Node 22.9+. **One dependency:** `@solana/web3.js` 1.98.4, pinned exactly as in `app/` (devnet reads; the server never signs). Install with `npm ci --ignore-scripts`. `npm audit` reports the same 4 moderate advisories as `app/` (transitive, in web3.js's RPC client libraries; not reachable from the server's own code paths).

```bash
cp .env.example .env            # then fill in the key and voice IDs
npm run dev                     # http://127.0.0.1:8787, calls ElevenLabs
npm run dev:canned              # no ElevenLabs calls at all (iterate without spending credits)
npm test                        # mocked; never calls ElevenLabs
npm run probe                   # one live check of the STT/TTS contract (~25 TTS characters + ~2 s STT)
```

The server is untrusted like the rest of the laptop (`docs/SECURITY_MODEL.md`). It only turns speech into text and text into speech for the app. The device never hears or trusts anything it produces.

## Endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/health` | — | `{"mode":"live"\|"canned","stt":bool,"tts":bool}` (whether a key and voice are configured; never the key) |
| `POST /api/stt` | The raw recording as the body, `Content-Type` `audio/webm` (MediaRecorder), `audio/ogg`, `audio/wav` or `audio/mpeg`, 1 KB–1 MB. Optional `?names=Henry,Max`: contact names (device name rules, up to 16) added to the recognizer's keyterms | `{"text":"..."}` |
| `POST /api/requests` | JSON `{"recipient","token","amount","payer","payerName"?}`: base58 keys, `SOL` or `USDC`, amount in base units as a string (1 to 2^64-1), payer name up to 32 printable ASCII | `201` the request: `id`, a fresh random `reference` key, `requesterName` (`TK_REQUESTER_NAME`), `createdAt`, `expiresAt` (24 h), `status` `pending` |
| `GET /api/requests?recipient=…` or `?payer=…` | Exactly one of the two | `{"requests":[...]}`, newest first. Pending requests are checked on devnet first (below) |
| `GET /api/requests/:id` | — | One request (`404 not_found` if unknown). Every request has `blink`: its `solana-action:` URL (below) |
| `GET /actions.json` | — | Solana Actions rules: `/request/*` → `/api/actions/request/*` (**public**, below) |
| `GET /api/actions/request/:id` | — | The request as a Solana Action (**public**, below) |
| `POST /api/actions/request/:id` | JSON `{"account":"<payer base58>"}`, up to 1 KB | An unsigned transaction for the payer's wallet (**public**, below) |
| `GET /api/agent/token` | — | `{"token":"..."}`: a one-conversation WebRTC token for the disambiguation agent (`ELEVENLABS_AGENT_ID`, from `tools/setup-agent.mjs`). `503 no_agent` / `503 canned` make the app fall back to asking with its own voice. Limit 6/min, 60/day |
| `POST /api/tts` | JSON `{"text":"..."}`, 1–200 printable ASCII characters | `audio/mpeg` (`X-TK-Cache: hit\|miss`) |

Errors are JSON `{"error": code, "message": text}`:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `too_short`, `bad_names`, `bad_json`, `bad_text` | Invalid request |
| 403 | `forbidden` | `Origin` is not an `http://localhost` / `http://127.0.0.1` page, or `Host` is not localhost (DNS-rebinding guard) |
| 413 / 415 | `too_large` / `bad_type` | Body too big / wrong audio type |
| 429 | `busy`, `rate_limited` | Limits below; has `Retry-After` |
| 502 | `upstream_auth`, `upstream_voice`, `upstream_rejected`, `upstream_error`, `upstream_unreachable`, `upstream_bad_reply` | ElevenLabs refused or failed |
| 503 | `upstream_busy` | ElevenLabs rate limit or credits; has `Retry-After` |
| 503 | `no_key` | Live mode without a key or voice in `.env` |
| 504 | `upstream_timeout` | No answer in 15 s |

There are no retries anywhere: the app reports an error and the user tries again.

## ElevenLabs calls (checked 2026-11-18)

- **STT:** `POST https://api.elevenlabs.io/v1/speech-to-text`, multipart `file`, `model_id` (`TK_STT_MODEL`, default `scribe_v2`), `language_code=en`, `tag_audio_events=false`, `keyterms` = `USDC`, `SOL` + the names. Only `text` from the reply is passed on.
- **TTS:** `POST /v1/text-to-speech/{voice}?output_format=mp3_22050_32`, `model_id` (`TK_TTS_MODEL`, default `eleven_flash_v2_5`), stability 0.6, similarity 0.75. `{voice}` is `ELEVENLABS_APP_VOICE_ID`, or `ELEVENLABS_VOICE_ID` if that is unset.

## Safety

- **The key** is read from `server/.env` only. It is sent only to `api.elevenlabs.io` and is redacted from every error message and log line. Never put it in `app/`.
- **Localhost only:** the server listens on `127.0.0.1`, refuses other origins and hosts, and sends `Cache-Control: no-store`.
- **Logs** have one line per request: method, path, status, size, time, and `cache` / `upstream` / `canned` or the error code. Transcripts, text and audio are never logged.
- **Loop guards** (in memory, reset on restart):

  | Limit | Applies to |
  | --- | --- |
  | 300 requests/min | All requests |
  | 1 at a time, 12/min, 300/day | STT |
  | 60/min, 1500/day | TTS, uncached requests only |

- **TTS cache:** `server/cache/` (gitignored), keyed by SHA-256 of the text, voice, model, format and settings. A repeated phrase costs credits once.

## Payment requests (docs/EXTRATASKS.md Part 2)

"Request 5 USDC from Max" in the app creates a request here with the device wallet as recipient and Max's app-contact address as payer; Max's Taktile Pay page (`/pay`) lists the requests addressed to his wallet. Kept **in memory** (a restart forgets them; at most 200). Localhost only, like STT and TTS.

**Paid detection:** reading a pending request asks devnet (`api.devnet.solana.com`, genesis hash checked first: I9) for the transactions that mention its `reference` key, at most once every 5 s per request. It counts as paid only when a confirmed, successful one raised the recipient's SOL (or its devnet-USDC token account) by at least the amount; the signature and an explorer link are then returned. RPC errors leave it pending.

**Trust:** laptop-sourced (`docs/SECURITY_MODEL.md` "Command sources"). The server never signs, and the device takes no part (receiving needs no signature).

## Solana Actions (Blinks; docs/EXTRATASKS.md Part 2 B1)

Each payment request is also a standard Solana Action, the API behind Blinks, so any Actions client can pay it; Max's Taktile Pay page is one (`app/` `/pay`). Shapes and headers follow `@solana/actions-spec` 2.4.2 and `@solana/actions` (checked 2026-11-19), written by hand (`lib/actions.mjs`).

- **GET** `/api/actions/request/:id`: `{type:"action", icon, title:"Payment request from <TK_REQUESTER_NAME>", description:"<amount> <token> to <short address> on Solana devnet. Address phrase: <8 words>. …", label:"Pay <amount> <token>", links.actions:[{type:"transaction", label, href}]}`. The address phrase is the requester's 8 words (the same ones their device says for "what is my address"), so the payer can check the recipient. `404` with `{message}` if the request is unknown, expired or paid.
- **POST** with `{account}`: `{type:"transaction", transaction:<base64>, message}`. A legacy transaction with the payer as fee payer and a fresh devnet blockhash: a System transfer (SOL) or SPL Token `TransferChecked` between the two devnet-USDC token accounts (USDC), with the request's `reference` key appended read-only. **Unsigned: the server never signs.** `400` with `{message}` for a bad account, paying your own request, or a missing devnet-USDC account (payer or requester).
- **Headers on every Actions response, including `OPTIONS` (204):** `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,POST,PUT,OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids`, `Access-Control-Expose-Headers: X-Action-Version, X-Blockchain-Ids`, `X-Action-Version: 2.4`, `X-Blockchain-Ids: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet).
- **Public on purpose:** these routes (and only these) skip the localhost Origin/Host checks, so a Blinks client can reach them through a tunnel. They can only read a request and build an unsigned transaction; creating requests, STT, TTS and the agent stay localhost-only. Limit 120/min. `TK_PUBLIC_URL` sets the base of the links (a tunnel); otherwise the request's Host is used.
- Not claimed: Phantom and Solflare render Blinks natively only for registry-verified actions on X.com, which unregistered devnet actions are not.

### Blink links and a tunnel (B3)

Every request carries `blink`: `solana-action:<base>/api/actions/request/<id>`. The app shows it with a Copy button after "request …", and Taktile Pay shows it on each request. `<base>` is `TK_PUBLIC_URL`, or `http://localhost:<port>`, which only works on this machine. **The demo doesn't need a tunnel**: Taktile Pay runs on the same laptop.

To let an Actions client elsewhere open a request, expose this server over public HTTPS and restart it with the tunnel URL:

```bash
cloudflared tunnel --url http://localhost:8787      # prints https://<random>.trycloudflare.com
# or: ngrok http 8787                               # prints https://<random>.ngrok-free.app
# then in server/.env:  TK_PUBLIC_URL=https://<random>.trycloudflare.com   and restart npm run dev
```

Through the tunnel only the Actions routes answer (`/actions.json`, `/api/actions/*`): their CORS headers allow any origin, and they can only read a request and build an unsigned transaction. Every other route (STT, TTS, agent, creating and listing requests) is refused with `403`, because the tunnel's `Host` is not localhost. Stop the tunnel when you're done; the request ids are unguessable (96 random bits), but anyone with a link can see the amount and the requester's address.

## Canned mode

`npm run dev:canned` (or `TK_SERVER_MODE=canned`) never calls ElevenLabs and needs no key. STT returns `TK_CANNED_TRANSCRIPT` (default `send 0.01 SOL to Henry`) after the usual validation. TTS serves the cache if it has the phrase, otherwise a short beep (`audio/wav`). Responses carry `X-TK-Canned: 1`, and `/api/health` says `"mode":"canned"`, so the app can show it.
