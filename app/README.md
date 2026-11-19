# app/

Companion web app (Vite + TypeScript, strict mode, no UI framework). It connects to the device over Web Serial or to `sim/` over WebSocket. It will add voice input via push-to-talk, intent parsing, devnet transaction building with `@solana/web3.js`, the app-side checksum phrase and broadcasting (docs/TASKS.md, Day 5–7).

- **Browser:** Chrome or Edge for USB (Web Serial). The simulator works in any browser.
- **Accessibility:** the app must be fully keyboard- and screen-reader-usable (labels, live regions for status). Accessibility is the product.
- **Untrusted by design:** never send the device a name, amount or summary to display or speak (I1).
- **No ElevenLabs key here:** speech goes through `server/` (`/api` is proxied to `127.0.0.1:8787`).

```bash
npm install
npm run dev        # http://localhost:5173 (localhost only: the sim and server/ accept only localhost pages)
npm test           # protocol, client and checksum tests in Node, no browser
npm run check      # tsc (app + tests), eslint, prettier
npm run build      # production bundle in dist/
```

## Layout

| Path                                         | What                                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/proto/frame.ts`, `crc32.ts`             | Frame encode and streaming decode, same rules as `core/src/tk_proto.c`                                                                                                                          |
| `src/proto/client.ts`                        | `DeviceClient`: seq pairing, events, one on-device flow at a time, timeouts (a flow that times out is cancelled on the device), typed HELLO / GET_PUBKEY / UNLOCK / CONTACT_LIST_COUNT / CANCEL |
| `src/proto/codes.ts`                         | Message types, statuses, events, errors, and the sentence the app says for each                                                                                                                 |
| `src/transport/`                             | `Transport` interface; `webserial.ts` (vendor `0x303A`), `websocket.ts` (`ws://localhost:8765`), `mock.ts` (scripted replies, for tests)                                                        |
| `src/connection.ts`                          | Connect, HELLO refresh every 15 s, unlock, cancel                                                                                                                                               |
| `src/state.ts`, `src/announce.ts`, `src/ui/` | Store, live regions (polite status + assertive alerts), page sections                                                                                                                           |
| `src/checksum.ts`                            | App-side checksum phrases (`tests/vectors/checksum.json`)                                                                                                                                       |

## Connecting

- **USB:** "Connect device (USB)" shows the browser's port picker the first time; pick the `303A` device. After that the permission is remembered for this browser profile, and the button reads "Reconnect device (USB)" with no picker. Close any serial monitor or script first: only one program can hold the port.
- **Simulator:** start `taktile-sim` (in WSL on Windows; WSL forwards `localhost:8765`), then "Use simulator". The sim locks its key-store wallet whenever the app disconnects.
- **URL switches:** `?debug=1` logs every frame as hex. `?signals=off` drives DTR/RTS low right after opening the port. By default the app never touches them; the switch is only for the reset check below.

**Reset check** (milestone M2):

1. Unlock on the device.
2. Disconnect and reconnect three times, then reload the page and connect.
3. HELLO must still report "Wallet unlocked". If it reports "locked", opening the port reset the chip or ended the session.

Result (2026-11-18, Chrome on Windows, default signals): the device stays unlocked across 3 disconnect/reconnects and a page reload. Opening the port does not reset the chip, so `?signals=off` is not needed.
