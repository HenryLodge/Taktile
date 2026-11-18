# Security model

## Trust boundary

| Trusted | Untrusted |
| --- | --- |
| Device firmware and its storage | Laptop OS, browser, extensions |
| The user's PIN (in their head) | `app/` and `server/` code at runtime |
| Physical button presses | USB serial link contents |
| Audio from the device's own earpiece | Anything spoken by the laptop |
| Pinned constants compiled into firmware (program IDs, devnet USDC mint) | RPC responses, ElevenLabs output |

## Invariants (never break these; changing one requires human sign-off and a doc update)

1. **I1 — Device-side parsing.** The device derives amount, token, and destination from raw message bytes. The protocol carries no host-supplied labels.
2. **I2 — No secret egress.** Seed, private key, PIN, PIN-entry state, checksum phrases, and recovery words never leave the device except as audio to the earpiece. No debug log prints them, including in `sim/` (sim may print *that* a phrase was played, and print the words only when built with `-DTK_SIM_INSECURE_AUDIO=1` for development).
3. **I3 — Reverse lookup only.** Destination → contact name. Never resolve a name sent by the host.
4. **I4 — Allowlist parsing.** Only the transaction shapes in `SOLANA.md` are accepted. Everything else is rejected.
5. **I5 — Fee payer is us.** The message's fee payer (account key 0) must equal the device's own public key, and the device must be the only required signer.
6. **I6 — Confirmation after announcement.** CONFIRM presses that happen before the announcement finishes are ignored (prevents "press-ahead"). The confirm window times out after 30 s → reject.
7. **I7 — PIN protection.** 6-digit PIN. The wallet key is encrypted under a key derived with PBKDF2-HMAC-SHA256 from the PIN and a random 16-byte salt (fresh per wallet, stored with it): **20,000 iterations, 64 bytes of output, measured 2,595 ms on the device** (two PBKDF2 blocks of 1,297 ms each, bring-up step K, 2026-11-17; decided 2026-11-17, lowered from ≥ 100,000, which would take 13 s: offline guessing is not defended in this build anyway, see the flash-dump row, and the 10-try wipe is the online defense). Blob layout and construction: `core/include/tk_keystore.h` (encrypt with HMAC-SHA256(Kenc, label) as a one-time pad, then HMAC-SHA256 tag with Kmac over everything; a wrong PIN fails the tag, compared in constant time). A stored blob that can't be read counts as a wallet that never unlocks, so it can't be silently replaced (I10). **Failed-attempt counter** (NVS `pin-fails`): every attempt is counted and committed *before* the PIN is checked, so cutting power during the 2.6 s check still counts it; if the counter can't be read or written, the PIN is not checked at all (`DEVICE_ERROR`). A correct PIN resets it to 0. **10 failures in a row → wipe**, in this order: the wallet blob is cleared (the key is gone once that commits), RAM is wiped, the counter is reset, then the contact book is wiped; if power is cut before the wallet is cleared, the counter is already at 10 and the next boot finishes the wipe; if the wallet can't be cleared, it is treated as corrupt (never unlocks, can't be replaced). After a wipe the device has no wallet and SETUP is allowed again (I10). **Unlocked sessions are short:** the device locks after every signature, 5 minutes after an unlock, when the USB host goes away, and at every boot (the key is only ever in RAM); only the boot-relative clock is used, so a clock reset can only lock it. `core/src/tk_keystore.c`. This defends against online guessing only: with a raw flash dump, a 6-digit PIN can be brute-forced offline. Flash encryption (P1, board #2) is the defense for that.
8. **I8 — No radios.** Wi-Fi and Bluetooth are never initialized.
9. **I9 — Devnet only** for the hackathon build. The USDC mint is pinned in firmware.
10. **I10 — No silent wallet replacement.** `SETUP` is refused with `WALLET_EXISTS` while a wallet exists. The only way to a new wallet is the 10-failure wipe (or a future on-device wipe that requires PIN + CONFIRM).
11. **I11 — True entropy.** With radios off, the ESP32-S3 RNG is only truly random when its internal entropy source is enabled. Firmware calls `bootloader_random_enable()` early in `app_main`, before anything uses `random_bytes` (seed generation, PIN start digits), and never disables it. Firmware never initializes the ADC: ESP-IDF documents that using the ADC interferes with the entropy source (the build checks also keep the `esp_adc` component out). SETUP's 256 bits of BIP39 entropy are `SHA-256("TK-ENT-v1" || 32 hardware RNG bytes || digest of the PIN-entry presses and their timing)` (`core/src/tk_seed.c`, `tk_setup.c`): defense in depth only, since the hardware bytes alone are full-entropy; mixing can never reduce it. The PIN is therefore chosen before the words are generated.

## Transaction limits

There are none, by design. The user is in control of all of their transactions: no caps, cooldowns, delays, or new-contact limits. The device's job is to tell the user the truth (I1, I3) and require their physical approval (I6, I7), not to second-guess them.

## What the checksum phrase does and does not do

Be precise about this in the README and pitch.

- The **primary** defense against a compromised laptop is I1 + I3: the device itself announces the real amount and the real recipient name (or "unknown recipient"). Full laptop compromise cannot change what the device says.
- The **checksum phrase** binds the user's request to the exact bytes. The app computes it from the bytes it built; the device computes it from the bytes it received. A mismatch catches tampering *between* the app and the device (malicious extension, a different app grabbing the serial port, a stale or queued request) and confirms "this is the request I just made." It does **not** by itself defeat malware that controls the app, since that malware would compute a matching phrase for its own bytes.
- The **address phrase** used at contact enrollment is 8 words (64 bits), not 3. Enrollment is the one place an attacker can choose the address, and a 24-bit phrase could be matched by brute-forcing keypairs against a known target address in minutes.

## Threats and status

| Threat | Defense | Status |
| --- | --- | --- |
| Laptop malware swaps destination | I1, I3: "unknown recipient" | P0, demoed |
| Malware changes amount | I1: device speaks real amount | P0 |
| Speech-to-text mishears | Device speaks contact name from its store | P0 |
| Injected audio / bystander commands | PIN session + physical CONFIRM | P0 |
| Shoulder surfing the PIN | Rotary PIN entry with private random start digit (`AUDIO.md`) | P0 |
| Device theft without PIN | I7 (online guessing) | P0 |
| Host replaces the wallet via SETUP | I10 | P0 |
| Weak RNG with radios off | I11 | P0 |
| Malicious contact enrollment | Out-of-band 8-word (64-bit) address phrase | P0 |
| Coercion, scam calls | Out of scope by design: the user controls all transactions; the device announces the real recipient and amount | — |
| Physical flash dump | **Not defended in this build.** One board, so no NVS or flash encryption (both burn eFuses). The seed is encrypted under the PIN-derived key (I7), but a 6-digit PIN can be brute-forced offline from a dump. The lockout wipe is logical: NVS may keep the old encrypted blob in a stale page until it is reused, so a dump taken after a wipe may still contain it | — ; flash encryption or a secure element is future work |
