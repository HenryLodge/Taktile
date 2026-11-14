# Solana transaction rules

The device signs Solana **legacy** messages on **devnet** only, and only the two shapes below. Everything else returns `PARSE_UNSUPPORTED`.

## Pinned constants (`core/include/tk_solana_consts.h`)

| Name | Base58 | Notes |
| --- | --- | --- |
| System Program | `11111111111111111111111111111111` | |
| SPL Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | Token-2022 is not supported |
| Associated Token Account Program | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | Used only for on-device ATA derivation |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Verified against Circle's "USDC contract addresses" page on 2026-11-13. Decimals = 6 |

Store these as 32-byte arrays decoded at build time (a `tools/` script emits the header), not base58 strings parsed at runtime.

## Legacy message layout (what the device receives)

```
header:            u8 num_required_signatures
                   u8 num_readonly_signed_accounts
                   u8 num_readonly_unsigned_accounts
account_keys:      compact-u16 N, then N × 32 bytes
recent_blockhash:  32 bytes
instructions:      compact-u16 M, then M × {
                       u8 program_id_index
                       compact-u16 K, K × u8 account_index
                       compact-u16 L, L × u8 data
                   }
```

- If the first byte has the high bit set (`& 0x80`), it is a versioned (v0) message → reject.
- compact-u16: 7 bits per byte, little-endian, continuation bit `0x80`. Canonical encodings only, matching Solana's own `short_vec` decoder:
  - at most 3 bytes;
  - a final byte of `0x00` is rejected unless it is the only byte (otherwise a shorter encoding exists);
  - the 3rd byte must be ≤ `0x03` (so the value is ≤ `0xFFFF`) and has no continuation bit.
- Reject if any length runs past the buffer, or if bytes remain after the last instruction. The parser walks all `M` instructions for this, even though only one is allowed.
- Max message size accepted: 1232 bytes.

## Common checks (both shapes)

1. Header: `num_required_signatures == 1`, `num_readonly_signed_accounts == 0`, and `num_readonly_unsigned_accounts < N` (so the fee payer is writable). Other accounts' writable flags are not checked: a wrong flag only makes the transaction fail on-chain.
2. `account_keys[0] == device_pubkey` (fee payer and sole signer).
3. No key appears twice in `account_keys` (Solana rejects such transactions too). Every identity check (device, mint, program, source) compares the full 32-byte key, never an index position.
4. Exactly **one** instruction (`M == 1`).
5. `program_id_index < N`, every `account_index < N`.
6. Recent blockhash is not inspected (the host chooses it; it only affects validity window).

A zero amount is allowed in both shapes: the user is in control, and the device announces the amount.

## Order of checks (`core/src/tk_parser.c`)

The first failing check decides the result. Each rejection has an on-device reason (`tk_parse_result_t` in `tk_parser.h`) so tests can prove each vector fails for the intended rule; on the wire every rejection is `PARSE_UNSUPPORTED`.

1. Size (`TOO_LARGE`), empty (`TRUNCATED`), version bit (`VERSIONED`).
2. Structure, in reading order: `TRUNCATED`, `BAD_COMPACT_U16`, then `TRAILING_BYTES`.
3. Common checks 1–5 above: `BAD_HEADER`, `FEE_PAYER`, `DUPLICATE_KEY`, `INSTRUCTION_COUNT`, `INDEX_OUT_OF_RANGE`.
4. Program: System → Shape A, Token → Shape B, anything else (including Token-2022) → `UNSUPPORTED_PROGRAM`.
5. Shape A: `SOL_LAYOUT` (K, L, discriminator), then `SOL_FROM_NOT_DEVICE`.
6. Shape B: `TOKEN_LAYOUT` (K, L, discriminator), then `TOKEN_WRONG_MINT`, `TOKEN_WRONG_DECIMALS`, `TOKEN_WRONG_SOURCE`, `TOKEN_OWNER_NOT_DEVICE`.

## Shape A — SOL transfer (System Program)

- `account_keys[program_id_index] == SYSTEM_PROGRAM`
- `K == 2`; accounts = `[from, to]`
- `from == account_keys[0]` (device)
- Data: `L == 12`, bytes `0..4` = `u32 LE 2` (Transfer), bytes `4..12` = `u64 LE lamports`
- Destination to resolve against contacts: `to` (a wallet address)

## Shape B — USDC transfer (SPL Token `TransferChecked`)

- `account_keys[program_id_index] == TOKEN_PROGRAM`
- `K == 4`; accounts = `[source, mint, destination, owner]`
- `owner == account_keys[0]` (device)
- `mint == DEVNET_USDC_MINT`
- `source == ATA(device_pubkey, USDC)` computed on device. `core/ata` computes it once when the wallet loads; the parser takes it as an argument.
- Data: `L == 10`, byte 0 = `12` (TransferChecked), bytes `1..9` = `u64 LE amount`, byte 9 = `decimals`, must equal `6`
- Destination to resolve against contacts: `destination` (a token account), matched against each contact's stored `usdc_ata`

Plain `Transfer` (instruction 3) is rejected; only `TransferChecked` is accepted, because it commits to the mint and decimals.

The recipient's ATA must already exist. The demo setup script creates it; the device does not accept an ATA-creation instruction in P0.

## On-device ATA derivation

`ATA(wallet, mint) = find_program_address([wallet, TOKEN_PROGRAM, mint], ATA_PROGRAM)`

```
for bump in 255 down to 0:
    h = SHA256(wallet || TOKEN_PROGRAM || mint || [bump] || ATA_PROGRAM || "ProgramDerivedAddress")
    if h is NOT a valid ed25519 point: return h
```

Use trezor-crypto / ed25519-donna point decompression to test "is on curve" (decompression fails → off curve → valid PDA). Add test vectors comparing against `@solana/spl-token` `getAssociatedTokenAddressSync` for at least 5 wallets.

## Keys

- BIP39 24-word mnemonic generated on device with hardware RNG.
- Solana key via SLIP-10 Ed25519, path `m/44'/501'/0'/0'` (matches Phantom/Solflare). Test against a known vector before relying on it.

## Test vectors (`tests/vectors/*.json`)

Generate with `tools/gen-vectors.mjs` using web3.js. Outputs are committed: `tests/vectors/parser.json`, `tests/vectors/ata.json`, and the same data as C tables in `core/tests/gen/tk_parser_vectors.h` and `tk_ata_vectors.h` (so ctest never parses JSON).

Each parser vector: `{name, message_hex, device_pubkey, device_usdc_ata, expect: {status, reason, kind, amount, destination}}`.

- `message_hex`, `device_pubkey`, `device_usdc_ata`, `destination`: lowercase hex.
- `status`: `"OK"` or `"PARSE_UNSUPPORTED"`.
- `reason`: the `tk_parse_result_t` name without the `TK_PARSE_` prefix (`"OK"`, `"TRUNCATED"`, `"DUPLICATE_KEY"`, …). Every reason has at least one vector.
- `kind`: `"sol"` or `"usdc"`.
- `amount`: a decimal string (lamports, or USDC base units), because u64 doesn't fit in a JSON number.
- `destination`: the address to resolve against contacts (Shape A `to`, Shape B destination token account).
- `kind`, `amount` and `destination` are `null` unless `status` is `"OK"`.

Test wallets come from `Keypair.fromSeed(sha256("taktile-vector:<label>"))`. They are public test labels, never funded, and only public keys are written out.

Required negative cases:

- v0 message; two instructions; wrong fee payer; `num_required_signatures == 2`
- Token `Transfer` (3) instead of `TransferChecked`; wrong mint; decimals 9
- source ATA not the device's; owner not the device
- truncated buffer at every field boundary; non-canonical compact-u16; trailing bytes
- Token-2022 program ID
- readonly signed count != 0; readonly unsigned count == N; duplicate account key (device repeated, program repeated)
