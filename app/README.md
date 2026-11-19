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

## Sending (SOL and USDC)

Type a command such as `send 0.01 SOL to Henry` under **Send**. The flow (`src/send.ts`) runs in the order `firmware/tools/sign_devnet.py` proved on devnet:

1. Check the device's balance covers the amount plus the 0.000005 SOL fee. This is not a limit: a send that would fail on-chain is refused before the device is involved.
2. HELLO, then **UNLOCK** if the device is locked: you enter the PIN on the device.
3. Fetch the blockhash _after_ the PIN (it lasts about 60 s), then build the legacy message (`src/tx.ts`, the same web3.js calls as `tools/gen-vectors.mjs`) with the device as fee payer (I5).
4. Show the **app checksum** (3 words). The device says its own 3 words from the bytes it received; they must match.
5. **SIGN_REQUEST**: the device announces the amount, the recipient's name from _its_ contact book (or "unknown recipient") and its checksum, then waits for CONFIRM.
6. Verify the Ed25519 signature over exactly the bytes built (WebCrypto). Check the blockhash is still valid, then broadcast to devnet, wait for confirmation, and show the explorer link.

Nothing is broadcast unless the device answered OK with a signature that verifies. RPC is devnet only: the endpoint is a constant, and the app checks its genesis hash before the first call (`src/rpc.ts`).

**USDC** (Shape B): a `TransferChecked` of devnet USDC from the device's token account to the contact's. Both accounts are derived here exactly as the device derives them, and the instruction is built by hand (no spl-token in the browser), byte-equal to the `usdc_ok` vector. Before the device is involved, the app checks that the device has the USDC and 0.000005 SOL for the fee, and that the contact's USDC account exists (`tools/setup-devnet.mjs` creates it).

**Commands** (`src/intent.ts`, deterministic):

- **Grammar:** `send|pay|transfer|give <amount> <SOL|USDC> to <name>`.
- **Amounts:** digits (`0.01`, `.5`, `1,000`) or words (`two point five`, `one hundred twenty`).
- **Dollars:** `$5` and `5 dollars` mean USDC.
- **No token:** refused ("Say SOL or USDC").
- **Near-miss names** (one letter off): the app offers "Did you mean Henry?" and you press Enter to accept. It never guesses on its own.

**App contacts** are a name → address list kept in this browser's localStorage (`src/contacts.ts`). They are untrusted: the device checks every destination against its own contact book, and adding a contact here does not add it to the device.

## Connecting

- **USB:** "Connect device (USB)" shows the browser's port picker the first time; pick the `303A` device. After that the permission is remembered for this browser profile, and the button reads "Reconnect device (USB)" with no picker. Close any serial monitor or script first: only one program can hold the port.
- **Simulator:** start `taktile-sim` (in WSL on Windows; WSL forwards `localhost:8765`), then "Use simulator". The sim locks its key-store wallet whenever the app disconnects.
- **URL switches:** `?debug=1` logs every frame as hex. `?signals=off` drives DTR/RTS low right after opening the port. By default the app never touches them; the switch is only for the reset check below.

**Reset check** (milestone M2):

1. Unlock on the device.
2. Disconnect and reconnect three times, then reload the page and connect.
3. HELLO must still report "Wallet unlocked". If it reports "locked", opening the port reset the chip or ended the session.

Result (2026-11-18, Chrome on Windows, default signals): the device stays unlocked across 3 disconnect/reconnects and a page reload. Opening the port does not reset the chip, so `?signals=off` is not needed.
