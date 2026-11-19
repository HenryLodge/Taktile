# server/

Tiny localhost proxy for ElevenLabs Speech-to-Text and Text-to-Speech, so the API key never reaches the browser. Node 22.9+, **no dependencies** (`node:http` plus Node's built-in `fetch`, `FormData`, `Blob`).

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

## Canned mode

`npm run dev:canned` (or `TK_SERVER_MODE=canned`) never calls ElevenLabs and needs no key. STT returns `TK_CANNED_TRANSCRIPT` (default `send 0.01 SOL to Henry`) after the usual validation. TTS serves the cache if it has the phrase, otherwise a short beep (`audio/wav`). Responses carry `X-TK-Canned: 1`, and `/api/health` says `"mode":"canned"`, so the app can show it.
