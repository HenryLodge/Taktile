# Solana transaction rules

The device signs Solana **legacy** messages on **devnet** only, and only the four shapes below: A (SOL transfer), B (USDC transfer), C (stake with the pinned validator) and D (unstake). Everything else returns `PARSE_UNSUPPORTED`.

## Pinned constants (`core/include/tk_solana_consts.h`)

| Name | Base58 | Notes |
| --- | --- | --- |
| System Program | `11111111111111111111111111111111` | |
| SPL Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | Token-2022 is not supported |
| Associated Token Account Program | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | Used only for on-device ATA derivation |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Verified against Circle's "USDC contract addresses" page on 2026-11-13. Decimals = 6 |
| Stake Program | `Stake11111111111111111111111111111111111111` | Shapes C and D (staking). IDs below checked against web3.js 1.98.4 and devnet on 2026-11-19 |
| Stake config | `StakeConfig11111111111111111111111111111111` | DelegateStake still lists it (account 5) |
| Rent sysvar | `SysvarRent111111111111111111111111111111111` | Stake Initialize |
| Clock sysvar | `SysvarC1ock11111111111111111111111111111111` | DelegateStake, Deactivate |
| Stake history sysvar | `SysvarStakeHistory1111111111111111111111111` | DelegateStake |
| **Pinned validator** (vote account) | `FwR3PbjS5iyqzLiLugrBqKSa5EKZ4vK9SKs7eQXtT59f` | `tools/validator.json`: the only validator the device delegates to, spoken as "Kiln". It identifies itself on-chain as "Kiln devnet validator" (self-published, not verified). Chosen by the human 2026-11-19; changing it needs a firmware build and a new clip pack |

Store these as 32-byte arrays decoded at build time (`tools/gen-consts.mjs` emits the header from this table and `tools/validator.json`), not base58 strings parsed at runtime. `TK_STAKE_SPACE` = 200 bytes (a stake account) and `TK_STAKE_SEEDS` = 16 (seeds `tk-stake-0` … `tk-stake-15`) are defined there too.

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
- Reject if any length runs past the buffer, or if bytes remain after the last instruction. The parser walks all `M` instructions for this, even though at most three are allowed (it keeps the first three).
- Max message size accepted: 1232 bytes.

## Common checks (every shape)

1. Header: `num_required_signatures == 1`, `num_readonly_signed_accounts == 0`, and `num_readonly_unsigned_accounts < N` (so the fee payer is writable). Other accounts' writable flags are not checked: a wrong flag only makes the transaction fail on-chain.
2. `account_keys[0] == device_pubkey` (fee payer and sole signer).
3. No key appears twice in `account_keys` (Solana rejects such transactions too). Every identity check (device, mint, program, source) compares the full 32-byte key, never an index position.
4. Instruction count, per shape (decided 2026-11-19, D4): exactly **three** (`M == 3`) when the first instruction is System `CreateAccountWithSeed` (Shape C), otherwise exactly **one** (`M == 1`: Shapes A, B, D). Any other count is `INSTRUCTION_COUNT`.
5. `program_id_index < N` and every `account_index < N`, for every instruction.
6. Recent blockhash is not inspected (the host chooses it; it only affects validity window).

A zero amount is allowed in Shapes A, B and C: the user is in control, and the device announces the amount (devnet itself rejects a stake below the minimum delegation).

## Order of checks (`core/src/tk_parser.c`)

The first failing check decides the result. Each rejection has an on-device reason (`tk_parse_result_t` in `tk_parser.h`) so tests can prove each vector fails for the intended rule; on the wire every rejection is `PARSE_UNSUPPORTED`.

1. Size (`TOO_LARGE`), empty (`TRUNCATED`), version bit (`VERSIONED`).
2. Structure, in reading order: `TRUNCATED`, `BAD_COMPACT_U16`, then `TRAILING_BYTES`.
3. Common checks 1–5 above: `BAD_HEADER`, `FEE_PAYER`, `DUPLICATE_KEY`, `INSTRUCTION_COUNT`, `INDEX_OUT_OF_RANGE`.
4. Program of the first instruction: System with `CreateAccountWithSeed` (u32 3) → Shape C, other System → Shape A, Token → Shape B, Stake → Shape D, anything else (including Token-2022) → `UNSUPPORTED_PROGRAM`.
5. Shape A: `SOL_LAYOUT` (K, L, discriminator), then `SOL_FROM_NOT_DEVICE`.
6. Shape B: `TOKEN_LAYOUT` (K, L, discriminator), then `TOKEN_WRONG_MINT`, `TOKEN_WRONG_DECIMALS`, `TOKEN_WRONG_SOURCE`, `TOKEN_OWNER_NOT_DEVICE`.
7. Shape C, instruction by instruction: CreateAccountWithSeed `STAKE_LAYOUT`, `STAKE_FUNDER_NOT_DEVICE`, `STAKE_BASE_NOT_DEVICE`, `STAKE_SEED`, `STAKE_WRONG_OWNER`, `STAKE_WRONG_SPACE`, `STAKE_ADDRESS_MISMATCH`; Initialize `STAKE_LAYOUT`, `STAKE_WRONG_ACCOUNT`, `STAKE_WRONG_SYSVAR` (rent), `STAKE_AUTHORITY_NOT_DEVICE` (staker, withdrawer), `STAKE_LOCKUP`; DelegateStake `STAKE_LAYOUT`, `STAKE_WRONG_ACCOUNT`, `STAKE_WRONG_SYSVAR` (clock, stake history, config), `STAKE_AUTHORITY_NOT_DEVICE`, and last `STAKE_WRONG_VALIDATOR` (so "unknown validator" is only said when everything else is right).
8. Shape D: `STAKE_LAYOUT`, `STAKE_WRONG_SYSVAR` (clock), `STAKE_AUTHORITY_NOT_DEVICE`, `STAKE_NOT_DERIVED`.

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

## Shape C — stake with the pinned validator (decided 2026-11-19)

Exactly three instructions, in this order (layouts checked against web3.js 1.98.4 and simulated on devnet, EXTRATASKS S0). The stake account is derived, not chosen: `createWithSeed(base = device, seed = "tk-stake-<n>", owner = Stake Program) = SHA256(device || seed || STAKE_PROGRAM)` for n in 0–15, so the device recognizes its own accounts and stays the only signer.

1. **System `CreateAccountWithSeed`**: `K == 2`, accounts `[funder, new]` (web3.js omits the base account when base = funder; a third account is rejected). Data: `u32 3`, `base[32]`, `u64 seed_len`, `seed`, `u64 lamports`, `u64 space`, `owner[32]`; `L` must equal `92 + seed_len` (seed_len ≤ 32). Checks: funder = device, base = device, seed is exactly `tk-stake-0` … `tk-stake-15` (no leading zero, case-sensitive), owner = Stake Program, space = 200, new account = the address recomputed on device. `lamports` is the amount announced (it includes the rent-exempt reserve, 0.00166624 SOL on devnet).
2. **Stake `Initialize`**: `K == 2`, accounts `[stake, rent sysvar]`, `L == 116`, data `u32 0`, `staker[32]`, `withdrawer[32]`, lockup `{i64 unix_timestamp, u64 epoch, custodian[32]}`. Checks: same stake account; rent sysvar pinned; **staker = device and withdrawer = device; the whole lockup is zero** (timestamp 0, epoch 0, custodian all zeros). This is the critical check: otherwise a malicious host could name itself withdrawer or lockup custodian and take the SOL later (SECURITY_MODEL "Staking").
3. **Stake `DelegateStake`**: `K == 6`, accounts `[stake, vote, clock, stake history, stake config, authority]`, data `u32 2` (`L == 4`). Checks: same stake account; clock, stake history and config pinned; authority = device; **vote = the pinned validator** (`TK_VALIDATOR_VOTE`, Kiln). A wrong validator is refused with "unknown validator, do not sign".

Result: kind stake, amount = lamports, destination = the stake account, index n. There is no contact lookup: the destination is the device's own account.

## Shape D — unstake

Exactly one **Stake `Deactivate`**: `K == 3`, accounts `[stake, clock, authority]`, data `u32 5` (`L == 4`). Checks: clock pinned; authority = device; the stake account is one of the device's own `tk-stake-0` … `tk-stake-15` (recomputed on device; anything else is `STAKE_NOT_DERIVED`). Every other Stake instruction (Authorize, Withdraw, Split, SetLockup, Merge, …) is `STAKE_LAYOUT`. Result: kind unstake, amount 0, destination = the stake account, index n. Withdrawing after the cooldown is out of scope for this build.

## On-device ATA derivation

`ATA(wallet, mint) = find_program_address([wallet, TOKEN_PROGRAM, mint], ATA_PROGRAM)`

```
for bump in 255 down to 0:
    h = SHA256(wallet || TOKEN_PROGRAM || mint || [bump] || ATA_PROGRAM || "ProgramDerivedAddress")
    if h is NOT a valid ed25519 point: return h
```

Implemented in `core/src/tk_ata.c` (`tk_ata_derive`). "Is on curve" is ed25519-donna point decompression (`tk_ed25519_on_curve`, a wrapper in `core/third_party/tk_ed25519_point.c`): decompression fails → off curve → valid PDA.

The rule must match Solana on-chain, which uses curve25519-dalek `CompressedEdwardsY::decompress()`: the top bit is the sign of x and is ignored when reading y; y ≥ p is reduced mod p; the point is valid exactly when (y² − 1)/(d·y² + 1) is a square; x = 0 with the sign bit set is accepted. donna behaves the same way. web3.js `PublicKey.isOnCurve` is stricter on the last two cases (probability ~2⁻²⁵⁰ for a hash); the device follows the on-chain rule, and `test_ata.c` pins both edge cases.

The wallet's own USDC ATA is derived once when the wallet loads and passed to the parser as `device_usdc_ata`.

## Keys

- BIP39 24-word mnemonic generated on device with hardware RNG.
- Solana key via SLIP-10 Ed25519, path `m/44'/501'/0'/0'` (matches Phantom/Solflare), no BIP39 passphrase. `core/src/tk_seed.c`.
- Vectors (`tests/vectors/seed.json`, `core/tests/gen/tk_seed_vectors.h`, written by `tools/gen-vectors.mjs`): the published SLIP-0010 Ed25519 test vectors 1 and 2 and the 24-word trezor/python-mnemonic BIP39 vectors, both copied in and re-derived with `node:crypto`; plus the same mnemonics at the Solana path with web3.js public keys (`solana_*`; public test data, never fund them). Bring-up step K repeats a BIP39 and a Solana-path known answer on the device.

## Test vectors (`tests/vectors/*.json`)

Generate with `tools/gen-vectors.mjs` using web3.js. Outputs are committed: `tests/vectors/{parser,ata,curve}.json`, and the same data as C tables in `core/tests/gen/tk_{parser,ata,curve}_vectors.h` (so ctest never parses JSON).

Each ATA vector: `{name, wallet, mint, ata, bump}` (hex keys), checked against `getAssociatedTokenAddressSync` and `findProgramAddressSync`. The six named wallets use devnet USDC; two more use a second test mint (label `other-mint`, so a derivation that ignores the mint fails); two `deep_*` vectors need a bump ≤ 251.

Each curve vector: `{name, bytes, on_curve}`: `sha256("taktile-curve:<i>")` for i in 0..31 and web3.js `PublicKey.isOnCurve`.

Each parser vector: `{name, message_hex, device_pubkey, device_usdc_ata, expect: {status, reason, kind, amount, destination}}`.

- `message_hex`, `device_pubkey`, `device_usdc_ata`, `destination`: lowercase hex.
- `status`: `"OK"` or `"PARSE_UNSUPPORTED"`.
- `reason`: the `tk_parse_result_t` name without the `TK_PARSE_` prefix (`"OK"`, `"TRUNCATED"`, `"DUPLICATE_KEY"`, …). Every reason has at least one vector.
- `kind`: `"sol"`, `"usdc"`, `"stake"` or `"unstake"`.
- `stake_index`: n of `tk-stake-<n>` for stake and unstake; otherwise `null`.
- `amount`: a decimal string (lamports, or USDC base units), because u64 doesn't fit in a JSON number.
- `destination`: the address to resolve against contacts (Shape A `to`, Shape B destination token account).
- `kind`, `amount`, `destination` and `stake_index` are `null` unless `status` is `"OK"`. The OK stake and unstake messages are checked byte-equal to what web3.js builds, and the derived addresses against web3.js `createWithSeed`.

Test wallets come from `Keypair.fromSeed(sha256("taktile-vector:<label>"))`. They are public test labels, never funded, and only public keys are written out.

Required negative cases:

- v0 message; two instructions; wrong fee payer; `num_required_signatures == 2`
- Token `Transfer` (3) instead of `TransferChecked`; wrong mint; decimals 9
- source ATA not the device's; owner not the device
- truncated buffer at every field boundary; non-canonical compact-u16; trailing bytes
- Token-2022 program ID
- readonly signed count != 0; readonly unsigned count == N; duplicate account key (device repeated, program repeated)
- Staking: withdrawer or staker not the device; lockup custodian, epoch or timestamp set; vote account not the pinned validator; created address not the recomputed one; seed outside `tk-stake-0..15`; owner not the Stake Program; space not 200; base or funder not the device; instructions reordered, missing or extra; Delegate or Deactivate authority not the device; Initialize or Delegate on another account; wrong rent, clock, stake history or config; Deactivate on an account that isn't the device's; Authorize, Withdraw, Split, SetLockup alone; truncation at every field of both messages
