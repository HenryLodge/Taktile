# Security model

## Trust boundary

| Trusted | Untrusted |
| --- | --- |
| Device firmware and its storage | Laptop OS, browser, extensions |
| The user's PIN (in their head) | `app/` and `server/` code at runtime |
| Physical button presses | USB serial link contents |
| Audio from the device's own earpiece | Anything spoken by the laptop |
| Pinned public keys compiled into firmware | RPC responses, ElevenLabs output |

## Invariants (never break these; changing one requires human sign-off and a doc update)

1. **I1 — Device-side parsing.** The device derives amount, token, and destination from raw message bytes. The protocol carries no host-supplied labels.
2. **I2 — No secret egress.** Seed, private key, PIN, PIN-entry state, checksum phrases, and recovery words never leave the device except as audio to the earpiece. No debug log prints them, including in `sim/` (sim may print *that* a phrase was played, and print the words only when built with `-DTK_SIM_INSECURE_AUDIO=1` for development).
3. **I3 — Reverse lookup only.** Destination → contact name. Never resolve a name sent by the host.
4. **I4 — Allowlist parsing.** Only the transaction shapes in `SOLANA.md` are accepted. Everything else is rejected.
5. **I5 — Fee payer is us.** The message's fee payer (account key 0) must equal the device's own public key, and the device must be the only required signer.
6. **I6 — Confirmation after announcement.** CONFIRM presses that happen before the announcement finishes are ignored (prevents "press-ahead"). The confirm window times out after 30 s → reject.
7. **I7 — PIN protection.** 6-digit PIN. Seed is encrypted under a key derived with PBKDF2-HMAC-SHA256 (≥ 100,000 iterations, tune for ~1 s on device) from PIN + a device-unique salt in NVS. Failed-attempt counter is persisted *before* checking the PIN. 10 failures → wipe seed and contacts.
8. **I8 — Policy cannot be bypassed by the host.** Caps and cooldowns are evaluated on device from device-stored state. Time-based rules use only verified timestamps (see below). If no verified time is available, time-dependent rules fail closed (treat as "cooldown not yet passed").
9. **I9 — No radios.** Wi-Fi and Bluetooth are never initialized.
10. **I10 — Devnet only** for the hackathon build. The USDC mint is pinned in firmware.

## Policy defaults (in `core/policy.c`, overridable only on device with PIN + CONFIRM)

| Rule | Default |
| --- | --- |
| Per-transaction cap | 50 USDC / 1 SOL |
| Rolling 24 h cap | 200 USDC / 5 SOL |
| New contact (added < 24 h ago) cap | 10 USDC / 0.1 SOL per tx |
| Over-cap request | Device records a pending request with verified time; same request can be confirmed after 24 h |

Amounts are compared in base units (USDC: 6 decimals; SOL: lamports).

## Time

The device has no trusted clock. It gets time by:

1. Device generates a 32-byte random nonce → `TIME_NONCE`.
2. Host relays the nonce to `server /api/time`, which returns `{unix_ms, signature}` where the signature is Ed25519 over `"TK-TIME-v1" || nonce || unix_ms (u64 LE)`.
3. Device verifies against the server public key pinned in firmware, checks the nonce matches the one it issued in the last 60 s, and that time never goes backwards versus the last stored verified time.

**Known limitation (state this in the README):** this trusts the team-run time server. Future work: multiple independent Roughtime servers with a quorum, or light-client verification of chain time.

## What the checksum phrase does and does not do

Be precise about this in the README and pitch.

- The **primary** defense against a compromised laptop is I1 + I3: the device itself announces the real amount and the real recipient name (or "unknown recipient"). Full laptop compromise cannot change what the device says.
- The **checksum phrase** binds the user's request to the exact bytes. The app computes it from the bytes it built; the device computes it from the bytes it received. A mismatch catches tampering *between* the app and the device (malicious extension, a different app grabbing the serial port, a stale or queued request) and confirms "this is the request I just made." It does **not** by itself defeat malware that controls the app, since that malware would compute a matching phrase for its own bytes.

## Threats and status

| Threat | Defense | Status |
| --- | --- | --- |
| Laptop malware swaps destination | I1, I3: "unknown recipient" | P0, demoed |
| Malware changes amount | I1: device speaks real amount; policy caps | P0 |
| Speech-to-text mishears | Device speaks contact name from its store | P0 |
| Injected audio / bystander commands | PIN session + physical CONFIRM | P0 |
| Shoulder surfing the PIN | Rotary PIN entry with private random start digit (`AUDIO.md`) | P0 |
| Device theft without PIN | I7 | P0 |
| Coercion, scam calls | Caps, 24 h delay, new-contact limits | P0 (firmware), P1 (verified time) |
| Malicious contact enrollment | Out-of-band address phrase + new-contact limits | P1 |
| Physical flash dump | NVS encryption + flash encryption (board #2) | P1; secure element is future work |
| Replay of an old signed time | Device-issued nonce, monotonic check | P1 |
