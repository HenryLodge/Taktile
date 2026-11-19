# Serial protocol (v1)

Transport: USB CDC-ACM on the ESP32-S3 native USB port (Web Serial in the browser), or WebSocket binary frames to `ws://localhost:8765` for `sim/`. Same frames either way. Baud rate is ignored on native USB; use 115200 in Web Serial.

Request/response, one request in flight at a time. The device may also send unsolicited `EVENT` frames while handling a request.

**Requests during an on-device flow** (e.g. a `SIGN_REQUEST` waiting for PIN or CONFIRM; `core/src/tk_flow.c`):

- `HELLO` is answered normally.
- `CANCEL` gets `OK` (with the CANCEL's seq) and ends the flow; the original request then gets `CANCELLED` (with its own seq). `CANCEL` with no flow running also gets `OK`.
- Any other request, including an unknown type, gets an immediate `BUSY` status reply with its own seq.
- `EVENT` frames carry the seq of the request whose flow sent them.
- The device never checks seq order; seq only pairs replies with requests.

**Not implemented yet:** `CONTACT_REMOVE` gets `ERROR{UNKNOWN_TYPE}` until its task lands (TASKS.md, deferred). Requests whose payload must be empty get `ERROR{BAD_PAYLOAD}` if it isn't.

## Frame

```
offset  size  field
0       1     magic     0xE5
1       1     version   0x01
2       1     type      message type (below)
3       1     seq       request sequence number, echoed in the response
4       2     len       payload length, u16 LE, max 2048
6       len   payload
6+len   4     crc32     CRC-32 (IEEE) over bytes 0 .. 6+len-1, u32 LE
```

Framing errors (implemented in `core/src/tk_proto.c`):

- Bytes before a `0xE5` are skipped silently, with no reply.
- Bad `version` or bad CRC → `ERROR{BAD_FRAME}`. `len > 2048` → `ERROR{TOO_LARGE}` (checked as soon as the header arrives).
- These `ERROR` replies echo the rejected header's `seq` as a best-effort hint. It may itself be corrupt; that is harmless, because only one request is in flight and `seq` carries no security meaning.
- After an error, the device resumes scanning at the next `0xE5` *inside* the rejected bytes, so a real frame that began inside a corrupt one is still found.
- A partial frame is dropped after an idle timeout on the link (firmware sets the timeout), so a corrupt `len` can't stall the decoder.

## Message types

Host → device in `0x01–0x7F`, device → host in `0x81–0xFF` (request type | 0x80).

| Type | Name | Payload (host → device) | Response payload |
| --- | --- | --- | --- |
| 0x01 | `HELLO` | — | `fw_version u16` (LE), `proto_version u8`, `state u8` (0 = no wallet, 1 = locked, 2 = unlocked). Unlocked lasts until the next signature, 5 minutes, the USB host going away (cable unplugged, laptop asleep or off; closing the port does not count), or a reboot (SECURITY_MODEL I7) |
| 0x02 | `GET_PUBKEY` | — | `status u8`, `pubkey[32]` (only if a wallet exists; does not require unlock) |
| 0x03 | `SETUP` | — | `status u8`. Device runs PIN setup + seed generation + recovery-word playback entirely on device (`core/src/tk_setup.c`, AUDIO.md "SETUP"); the reply comes when it ends, minutes later. `OK` (wallet stored; the device is unlocked as after a PIN: until the next signature, 5 minutes, the USB host going away, or a reboot), `WALLET_EXISTS` (a wallet exists, I10; answered at once, nothing played), `CANCELLED` (host CANCEL, long REJECT, 3 PIN mismatches, or a timeout), `REJECTED_BY_USER` (REJECT), `DEVICE_ERROR` (no audio, speaker mode on, RNG or storage failure). Nothing is stored unless the reply is `OK`. During the flow: `EVENT AWAITING_PIN` once, HELLO reports state 0, other requests get `BUSY` |
| 0x04 | `UNLOCK` | — | `status u8`. PIN entry ahead of a `SIGN_REQUEST`, so the host can fetch a fresh blockhash *after* the PIN (a blockhash lasts about 60 s; announcement, PIN and the 2.6 s check together took 50 s). Answered at once: `OK` if already unlocked, `NO_WALLET` (both silent), `DEVICE_ERROR` (no audio). Otherwise the device runs PIN entry (AUDIO.md "Unlocking") and replies when it ends: `OK` ("wallet unlocked"), `REJECTED_BY_USER` (REJECT, or no press for 60 s), `CANCELLED` (host CANCEL, long REJECT), `LOCKED_OUT` (10th wrong PIN: wallet and contacts wiped), `DEVICE_ERROR` (the key store can't check a PIN). It opens the same session a sign flow's PIN does (SECURITY_MODEL I7: locks after one signature, 5 minutes, USB host gone (not a closed port), reboot); every signature still needs the announcement and CONFIRM (I5). During the flow: `EVENT AWAITING_PIN` per attempt; HELLO is answered, other requests get `BUSY`. A payload gets `ERROR{BAD_PAYLOAD}`, nothing played. Added 2026-11-18 (proto version stays 1; older firmware answers `ERROR{UNKNOWN_TYPE}`) |
| 0x10 | `SIGN_REQUEST` | `message[len]` (legacy message bytes, not the full transaction) | `status u8`, then `signature[64]` if `status == OK`. If unlocked (after `UNLOCK`), the flow skips PIN entry: announcement, then CONFIRM |
| 0x30 | `CONTACT_ADD` | `name_len u8` (1–12), `name[name_len]` (ASCII, rules below), `wallet[32]`; the payload is exactly `1 + name_len + 32` bytes | `status u8`. Answered at once: `NO_WALLET` (silent), `DEVICE_ERROR` (no audio), `CONTACTS_FULL` ("contact book full"), `CONTACT_EXISTS` ("already a contact"). Otherwise the device runs enrollment on device (`core/src/tk_enroll.c`, AUDIO.md "Adding a contact": the spelled name and 8-word address phrase, PIN if locked, CONFIRM) and replies when it ends: `OK` (stored), `REJECTED_BY_USER` (REJECT, no press for 60 s during PIN entry, or the 30 s confirm window timed out), `CANCELLED` (host CANCEL, long REJECT), `LOCKED_OUT` (10th wrong PIN: wallet and contacts wiped), `DEVICE_ERROR` (the key store can't check a PIN, or saving failed). Nothing is stored unless the reply is `OK`. It is not a signature, so an unlocked session stays unlocked. During the flow: `EVENT ANNOUNCING`, `AWAITING_PIN` (if locked), `AWAITING_CONFIRM`; HELLO is answered, other requests get `BUSY`. A payload of the wrong length or a name that breaks the rules gets `ERROR{BAD_PAYLOAD}`, nothing played |
| 0x31 | `CONTACT_LIST_COUNT` | — | `count u8` (names are NOT returned; contacts stay on device) |
| 0x32 | `CONTACT_REMOVE` | `index u8` (insertion order; removal keeps the order of the rest) | `status u8`: `NOT_FOUND` if `index ≥ count`; otherwise the device says "remove <spelled name>", then requires PIN + CONFIRM (`OK`, `REJECTED_BY_USER`, `CANCELLED`) |
| 0x7E | `CANCEL` | — | `status u8` — aborts the current on-device flow |
| — | `EVENT` (0xF0, device → host only) | — | `event u8` (below) |
| — | `ERROR` (0xFF, device → host only) | — | `code u8` |

The contact name sent in `CONTACT_ADD` is what the *user* typed or said in the app; the device spells it back letter by letter during enrollment so the user verifies it. After enrollment the device only ever speaks its stored copy.

Contact name rules (`core/src/tk_contacts.c`): 1–12 characters from ASCII letters, digits, space, hyphen and apostrophe; no leading, trailing or double space (spaces are silent when spelled); unique ignoring case. A wallet already in the book is refused with `CONTACT_EXISTS`. The app validates names before sending. Lookup is by kind: a SOL destination is matched only against contacts' wallets, a USDC destination only against their USDC token accounts (derived on device).

## Status codes (`u8`)

| Code | Name | Meaning |
| --- | --- | --- |
| 0x00 | `OK` | |
| 0x01 | `REJECTED_BY_USER` | REJECT pressed or confirm window timed out |
| 0x02 | `UNKNOWN_RECIPIENT` | Destination not in contacts |
| 0x03 | `PARSE_UNSUPPORTED` | Not an allowed shape (SOLANA.md) |
| 0x04 | `LOCKED_OUT` | Too many PIN failures; device wiped |
| 0x05 | `NO_WALLET` | Run SETUP first |
| 0x06 | `BUSY` | Another flow in progress |
| 0x07 | `CANCELLED` | |
| 0x08 | `WALLET_EXISTS` | SETUP refused; a wallet already exists (I10) |
| 0x09 | `CONTACTS_FULL` | CONTACT_ADD refused; the book holds 16 contacts |
| 0x0A | `CONTACT_EXISTS` | CONTACT_ADD refused; same name (ignoring case) or same wallet already stored |
| 0x0B | `NOT_FOUND` | CONTACT_REMOVE index is not in the book |
| 0x0C | `DEVICE_ERROR` | The device can't do this safely, so it refused: no working audio (clip pack missing or stale, I2S down), the RNG refused, storage failed, or the key store can't check a PIN. Nothing was signed or stored. The app says to check the device (for audio: reflash the clip pack) |

## Events (`EVENT` payload)

Events tell the app what to *say on screen* for sighted helpers and what to put in an ARIA live region. They never carry content the user must verify.

| Code | Name |
| --- | --- |
| 0x01 | `ANNOUNCING` |
| 0x02 | `AWAITING_PIN` |
| 0x03 | `AWAITING_CONFIRM` |
| 0x04 | `SIGNING` |

Forbidden in any frame, ever: PIN digits, PIN-entry position or start digit, checksum words or indices, recovery words, seed or key material, contact names (except the name the host itself sent in `CONTACT_ADD`).

## Error codes (`ERROR` payload)

`0x01 BAD_FRAME`, `0x02 UNKNOWN_TYPE`, `0x03 BAD_PAYLOAD`, `0x04 TOO_LARGE`.

## Versioning

Bump `version` in the frame on any incompatible change and update this file in the same commit. The app refuses to talk to a device whose `HELLO.proto_version` differs.
