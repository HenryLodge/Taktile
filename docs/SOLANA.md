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
- compact-u16: 1–3 bytes, 7 bits per byte, little-endian, continuation bit `0x80`. Reject non-canonical encodings and values > 0xFFFF.
- Reject if any length runs past the buffer, or if bytes remain after the last instruction.
- Max message size accepted: 1232 bytes.

## Common checks (both shapes)

1. `num_required_signatures == 1`.
2. `account_keys[0] == device_pubkey` (fee payer and sole signer).
3. Exactly **one** instruction (`M == 1`).
4. `program_id_index < N`, every `account_index < N`.
5. Recent blockhash is not inspected (the host chooses it; it only affects validity window).

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
- `source == ATA(device_pubkey, USDC)` computed on device
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

Each parser vector: `{name, message_hex, device_pubkey, expect: {status, kind, amount, destination}}`.

- `message_hex`, `device_pubkey`, `destination`: lowercase hex.
- `status`: `"OK"` or `"PARSE_UNSUPPORTED"`.
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
