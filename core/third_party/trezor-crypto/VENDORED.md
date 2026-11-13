# Vendored: trezor-crypto (subset)

| | |
| --- | --- |
| Upstream | https://github.com/trezor/trezor-firmware, directory `crypto/` |
| Tag | `core/v2.13.1` |
| Commit | `4289e23b317e98ab6a5e8237723e0cd57f44934c` |
| License | MIT (`LICENSE`, `AUTHORS`) |
| Local patches | None. Files are byte-for-byte copies of upstream. |

## Files

- Top level: `bip39.c/.h`, `bip39_english.c`, `byte_order.h`, `consteq.c/.h`, `fault_handler.h`, `hmac.c/.h`, `memzero.c/.h`, `options.h`, `pbkdf2.c/.h`, `rand.h`, `sha2.c/.h`
- `ed25519-donna/`: `ed25519.c/.h`, `ed25519-donna.h`, `ed25519-donna-portable.h`, `ed25519-hash-custom.h` (SHA-512), and the 32-bit `curve25519-donna-*`, `ed25519-donna-*`, `modm-donna-32bit` sources. The Keccak/SHA-3 variants are omitted.

## Deliberately not vendored

- `rand.c`: Taktile supplies `random_buffer()` in `core/third_party/tk_trezor_glue.c`, and it **aborts**. All randomness comes from `tk_platform_t.random_bytes` (SECURITY_MODEL I11). Only the unused ed25519 "cosi" functions call `random_buffer()`; `ed25519_sign` is deterministic.
- `fault_handler_noop.c`: replaced by a `tc_fault_handler()` that aborts in the same glue file.
- `bip32.c` and its dependencies (secp256k1, NIST P-256, Cardano, base58, ...): SLIP-10 Ed25519 derivation is implemented in `core/` on top of `hmac_sha512`.

## Build configuration

- `USE_BIP39_CACHE=0`: no static mnemonic → seed cache, so seeds don't linger in RAM.
- Built with `-Wall` but without `-Werror` (see `core/third_party/CMakeLists.txt`).

## Updating

Sparse-clone the new tag (`git sparse-checkout set crypto`), copy the same file list over, update the tag and commit above, rebuild, and run `ctest`. Diff the changes before committing; this is security-critical code.
