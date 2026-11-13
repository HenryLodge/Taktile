# app/

Companion web app (Vite + TypeScript, strict mode). Voice input via push-to-talk, intent parsing, transaction building with `@solana/web3.js` on devnet, app-side checksum phrase, broadcast. Transport: Web Serial to the device or WebSocket to `sim/`.

- Chrome or Edge only (Web Serial).
- Fully keyboard- and screen-reader-usable: labels, live regions for status. Accessibility is the product.
- The app is untrusted by design. Never send the device a name, amount, or summary to display or speak (I1).
- Never put the ElevenLabs key here; use `server/`.

```bash
npm install && npm run dev
```
