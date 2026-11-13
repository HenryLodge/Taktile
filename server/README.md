# server/

Tiny Node + Express server that proxies ElevenLabs so the API key never reaches the browser.

- `/api/stt` → ElevenLabs Speech-to-Text
- `/api/tts` → ElevenLabs Text-to-Speech

Secrets live in `server/.env` (gitignored). Copy `.env.example` to `.env` and fill it in.

```bash
npm install && npm run dev
```
