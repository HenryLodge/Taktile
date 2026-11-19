# app/

Companion web app (Vite + TypeScript, strict mode, React for the UI). It connects to the device over Web Serial or to `sim/` over WebSocket. It turns typed or spoken commands (push-to-talk through `server/`) into devnet SOL and USDC transfers, speaks the app-side checksum, has the device announce and sign them, broadcasts them, and adds contacts to the device.

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

## Pages

- **`/` (home):** the talk orb and the conversation. Hold Space (or press Enter on the orb) to talk. The orb turns dark green and follows your voice level. Your words appear on the right, and Taktile's key replies (checksum, questions, result with the explorer link, errors) on the left. On load, the app reconnects without a picker to a USB device this browser was already allowed to use.
- **`/data`:** everything else: connect (USB or simulator), typed commands and toggles, contacts, my address phrase, device details, the full log, and keyboard help.

Both are views of one page (`src/ui/route.ts`, both stay mounted), so switching keeps the connection open. Space works on both.

**UI code:** `src/main.tsx` creates the controllers and renders `src/ui/App.tsx`. The logic modules (`send.ts`, `connection.ts`, `voice.ts`, `disambiguate.ts`, `enroll.ts`, …) have no React in them. `src/ui/send-controller.ts` and `voice-controller.ts` hold the UI state in small stores that components read with `useSyncExternalStore`. Components are in `src/ui/components/`. The demo-only module is `src/ui/demo-malware.tsx`, and normal builds never import it.

## Layout

| Path                                         | What                                                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/proto/frame.ts`, `crc32.ts`             | Frame encode and streaming decode, same rules as `core/src/tk_proto.c`                                                                                                                                                                  |
| `src/proto/client.ts`                        | `DeviceClient`: seq pairing, events, one on-device flow at a time, timeouts (a flow that times out is cancelled on the device), typed HELLO / GET_PUBKEY / UNLOCK / CONTACT_LIST_COUNT / SPEAK_ADDRESS / SPEAK_CONTACTS / LOCK / CANCEL |
| `src/proto/codes.ts`                         | Message types, statuses, events, errors, and the sentence the app says for each                                                                                                                                                         |
| `src/transport/`                             | `Transport` interface; `webserial.ts` (vendor `0x303A`), `websocket.ts` (`ws://localhost:8765`), `mock.ts` (scripted replies, for tests)                                                                                                |
| `src/connection.ts`                          | Connect, HELLO refresh every 15 s, unlock, cancel                                                                                                                                                                                       |
| `src/state.ts`, `src/announce.ts`, `src/ui/` | Store, live regions (polite status + assertive alerts), React UI                                                                                                                                                                        |
| `src/intent.ts`                              | Deterministic command parser: send, request, stake, unstake, balance, staked, activity, requests, address, contacts, lock, repeat, cancel, help (`docs/EXTRATASKS.md` Part 1)                                                           |
| `src/queries.ts`                             | Read-only voice answers from devnet: balance, staked (the 16 `tk-stake-<n>` accounts), the last 3 transactions, help. Information only, never an input to signing                                                                       |
| `src/checksum.ts`                            | App-side checksum phrases (`tests/vectors/checksum.json`)                                                                                                                                                                               |

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

## Asking which contact ("Jack Miller or Jack Chen?")

When the spoken name is the first word of two or more contacts ("send 1 USDC to Jack" with _Jack Miller_ and _Jack Chen_), the parser returns the candidates instead of guessing (`src/intent.ts`). The app then asks which one (`src/disambiguate.ts`):

1. **ElevenLabs agent** (default; the "Use the ElevenLabs assistant for questions" checkbox):
    - The app gets a one-conversation token from `server/` `/api/agent/token` and starts a short voice conversation. The agent is created by `tools/setup-agent.mjs`.
    - The agent asks "Did you mean Jack Miller or Jack Chen?" and you answer naturally ("Chen", "the second one").
    - Its only output is the client tool `choose_contact(name)`. The app accepts the name only if it is one of the candidates, so the agent can't add, change or invent anything.
    - The session ends on a choice, on "cancel", after 30 s, or on **Esc**. The log shows what the assistant and you said.
2. **Fallback** (agent switched off, not configured, server in canned mode, or it fails to start):
    - The app voice asks "Did you mean Jack Miller or Jack Chen? Hold Space and say the name."
    - Your next answer (spoken, or typed in the command box) is matched only against the candidates: the full name, or the word that tells them apart ("Chen"). "Cancel" stops.
    - There is only one round.

After a choice, the normal send runs with the original amount and token. The device announces the name it has stored, so a wrong pick is caught by ear. Typing the full name ("send 1 USDC to Jack Chen") never asks.

## Adding a contact

Under **Contacts**, enter a name (the device's rules: 1–12 letters, digits, spaces, hyphens, apostrophes) and the contact's wallet address, then **Add contact**.

1. The app saves the contact in its own list (untrusted, this browser only).
2. If the device is connected, the app immediately sends **CONTACT_ADD** (`src/enroll.ts`).
3. The device does the trusted part. It says "adding contact", spells the name, then says "address phrase" and **8 words computed from the address it received**.
4. **The phone-call check:** call the contact and have them read their phrase from **My address phrase**. The words must match word for word. Hold OK on the device to hear it again.
5. **Approve on the device:** enter the PIN if the device is locked, then CONFIRM to add or REJECT to cancel.

The app shows the device's progress on screen and in the live region. It never shows the words during enrollment, and the app voice says only the result:

| Device answer                       | App                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| OK                                  | "{name} is now a contact on the device." The row shows _on the device_ and the contact count updates |
| CONTACT_EXISTS                      | "{name} or that address is already on the device." Marked _on the device_; nothing is played         |
| REJECTED_BY_USER / CANCELLED        | Not added; the row keeps an **Add {name} to device** button to try again                             |
| CONTACTS_FULL                       | The book holds 16                                                                                    |
| LOCKED_OUT, NO_WALLET, DEVICE_ERROR | The status text                                                                                      |

When the device isn't connected, the contact is saved in the app and its row offers **Add to device** later.

_On the device_ is only a display hint. The device checks every recipient itself when signing, and contacts can't be removed from the device yet (CONTACT_REMOVE is deferred).

## My address phrase

This is for the person _being_ added. Paste your wallet address (or press **Use this device's address**), then **Show my phrase**. The app shows the 8 words in large type, and **Read aloud** speaks them with the app voice. They are the same words the adding device reads (`addressPhrase` in `src/checksum.ts`, held to the same `tests/vectors/checksum.json` as the device).

The phrase is public: it comes from a public address and is meant to be read over the phone (SECURITY_MODEL).

## Voice

**Push-to-talk** (`src/voice.ts`, `src/ui/voice.ts`):

- **Talking:** hold **Space** anywhere except in a text field or checkbox, say a command, release. On the talk button, **Enter** starts listening and Enter again stops: screen readers in browse mode turn Space into a click, so the toggle is the screen-reader path.
- **Feedback:** a high beep when recording starts and a low beep when it stops.
- **Length:** a recording under 0.4 s is refused ("Hold Space while you speak"), and recording stops by itself at 15 s.
- **Transcription:** the recording (`audio/webm` opus) goes to `server/` `/api/stt`, along with the app contact names as recognition hints. The transcript runs through the same intent parser and send flow as a typed command and **starts at once**: the device's announcement, PIN and CONFIRM are the real approval. A near-miss name still asks for Enter.
- **Microphone:** permission is asked once (or via "Enable microphone"), and the stream is kept open so the first word isn't clipped.
- **Errors:** each one is spoken and announced, and focus moves to the command box so you can type instead:
    - microphone blocked or missing;
    - nothing heard;
    - speech service busy or unavailable.

**App voice** (`src/speech.ts`): ElevenLabs text-to-speech through `server/` `/api/tts`, in a separate app voice (`ELEVENLABS_APP_VOICE_ID`). Only the important lines are spoken (decided 2026-11-18); progress stays on screen and in the screen-reader live regions:

1. **The checksum:** "Sending 1 USDC to Henry. Checksum: solo, aardvark, ruffled." It is spoken in full before SIGN_REQUEST, so it comes before the device's own announcement. Two independent channels say the same three words: the laptop from the bytes it built, and the earpiece from the bytes the device received. The flow waits at most 8 s for it.
2. **The final result:** "Sent and confirmed…" or the refusal.
3. **Voice problems:** microphone blocked or missing, nothing heard, speech service down, and command problems after speaking ("Say SOL or USDC", "Did you mean Henry?").

**When and how it speaks:**

- **Never over the device:** it never starts while the device is running a flow (PIN entry, announcement, CONFIRM). A line that comes up then waits until the device is done.
- **Queue:** one line at a time; errors interrupt.
- **Stopping:** **Esc** stops it, and the "Speak with app voice" checkbox turns it off (remembered in this browser).
- **Fallback:** if `server/` can't speak (offline, rate-limited, error), the browser's built-in voice says the line instead, with one note in the log. There are no retries.
- **Canned mode:** with `server/` in canned mode (`npm run dev:canned`), the transcript is fixed and the app voice is a beep, so no credits are used.

## Demo malware mode (demo builds only)

`npm run demo` (instead of `npm run dev`) loads `.env.demo` (`VITE_TK_DEMO_MALWARE=1`) and adds a red **DEMO ONLY: malware simulation** section. Turn it on with its checkbox or **Ctrl+Shift+M**; a sticky red banner and the page title say it is active. It is off on every page load.

**What it does:** it plays a malicious extension sitting between the app and the device (`src/malware.ts`, `MalwareTransport`):

1. The app builds the honest message, shows it, and speaks the honest checksum.
2. On the way out, SIGN_REQUEST has its recipient rewritten inside the message bytes, then is re-framed with a valid CRC:
    - SOL: to the attacker wallet `4jT8…memK`;
    - USDC: to the attacker's USDC account `FLbv…pQF` (created by `tools/setup-devnet.mjs`).
3. The device parses the real bytes, doesn't find the destination in its contact book, and says **"unknown recipient, do not sign"** (I1, I3). Nothing is signed or sent.

The log notes the rewrite for the audience. With `?debug=1`, the logged frame is the honest one, as it would be with real malware.

**Why it can't ship:** the module is only imported behind `import.meta.env.VITE_TK_DEMO_MALWARE === '1'`, which is dead code in any other build. Its UI and styles are created at runtime by the module itself. `npm run check` builds the app normally and fails if the attacker addresses or "malware" appear in `dist/` (`scripts/check-no-malware.mjs`).

## Connecting

- **USB:** "Connect device (USB)" shows the browser's port picker the first time; pick the `303A` device. After that the permission is remembered for this browser profile, and the button reads "Reconnect device (USB)" with no picker. Close any serial monitor or script first: only one program can hold the port.
- **Simulator:** start `taktile-sim` (in WSL on Windows; WSL forwards `localhost:8765`), then "Use simulator". The sim locks its key-store wallet whenever the app disconnects.
- **URL switches:** `?debug=1` logs every frame as hex. `?signals=off` drives DTR/RTS low right after opening the port. By default the app never touches them; the switch is only for the reset check below.

**Reset check** (milestone M2):

1. Unlock on the device.
2. Disconnect and reconnect three times, then reload the page and connect.
3. HELLO must still report "Wallet unlocked". If it reports "locked", opening the port reset the chip or ended the session.

Result (2026-11-18, Chrome on Windows, default signals): the device stays unlocked across 3 disconnect/reconnects and a page reload. Opening the port does not reset the chip, so `?signals=off` is not needed.

This also means **closing the app or disconnecting does not lock the device**: it locks after a signature, 5 minutes after an unlock, on a reboot, or when the USB host really goes away (cable unplugged, laptop asleep). Every signature still needs the device's announcement and CONFIRM (SECURITY_MODEL I7).
