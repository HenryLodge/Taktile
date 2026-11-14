# Serial protocol (v1)

Transport: USB CDC-ACM on the ESP32-S3 native USB port (Web Serial in the browser), or WebSocket binary frames to `ws://localhost:8765` for `sim/`. Same frames either way. Baud rate is ignored on native USB; use 115200 in Web Serial.

Request/response, one request in flight at a time. The device may also send unsolicited `EVENT` frames while handling a request.

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
| 0x01 | `HELLO` | — | `fw_version u16`, `proto_version u8`, `state u8` (0 = no wallet, 1 = locked, 2 = unlocked) |
| 0x02 | `GET_PUBKEY` | — | `status u8`, `pubkey[32]` (only if a wallet exists; does not require unlock) |
| 0x03 | `SETUP` | — | `status u8`. Device runs seed generation + recovery-word playback + PIN setup entirely on device. Refused with `WALLET_EXISTS` if a wallet already exists |
| 0x10 | `SIGN_REQUEST` | `message[len]` (legacy message bytes, not the full transaction) | `status u8`, then `signature[64]` if `status == OK` |
| 0x30 | `CONTACT_ADD` | `name_len u8`, `name[name_len]` (UTF-8, ≤ 32 bytes), `wallet[32]` | `status u8` |
| 0x31 | `CONTACT_LIST_COUNT` | — | `count u8` (names are NOT returned; contacts stay on device) |
| 0x32 | `CONTACT_REMOVE` | `index u8` | `status u8` (requires PIN + CONFIRM) |
| 0x7E | `CANCEL` | — | `status u8` — aborts the current on-device flow |
| — | `EVENT` (0xF0, device → host only) | — | `event u8` (below) |
| — | `ERROR` (0xFF, device → host only) | — | `code u8` |

The contact name sent in `CONTACT_ADD` is what the *user* typed or said in the app; the device spells it back letter by letter during enrollment so the user verifies it. After enrollment the device only ever speaks its stored copy.

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
