// Wallet seed derivation for SETUP (docs/SOLANA.md "Keys"): 256 bits of entropy -> 24-word BIP39
// English mnemonic -> 64-byte BIP39 seed -> SLIP-10 Ed25519 key at m/44'/501'/0'/0' (Phantom and
// Solflare use the same path).
//
// Everything here is secret (I2): callers wipe every output with memzero once used. Nothing is
// logged. No allocation; the mnemonic text only ever exists in a caller-provided buffer.

#ifndef TK_SEED_H
#define TK_SEED_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TK_SEED_ENTROPY_LEN 32u
#define TK_SEED_WORDS 24u
#define TK_SEED_WORD_COUNT 2048u // BIP39 English list
#define TK_SEED_LEN 64u          // BIP39 seed
#define TK_SEED_KEY_LEN 32u      // SLIP-10 Ed25519 private key (the Ed25519 secret seed)
// Longest mnemonic: 24 words of at most 8 letters, 23 spaces, NUL.
#define TK_SEED_MNEMONIC_MAX (TK_SEED_WORDS * 9u)

#define TK_SLIP10_HARDENED 0x80000000u
#define TK_SOLANA_PATH_LEN 4u
extern const uint32_t TK_SOLANA_PATH[TK_SOLANA_PATH_LEN]; // 44' / 501' / 0' / 0'

// SETUP's entropy (SECURITY_MODEL I11): SHA-256("TK-ENT-v1" || hw || timing), where hw is 32 bytes
// from the hardware RNG and timing is a digest of the user's button presses. Mixing can only add
// entropy: hw alone is already 256 bits from the entropy source.
void tk_seed_mix_entropy(const uint8_t hw[TK_SEED_ENTROPY_LEN], const uint8_t timing[32],
                         uint8_t out[TK_SEED_ENTROPY_LEN]);

// The 24 BIP39 word indices (0..2047) for 32 bytes of entropy: 256 entropy bits, then the first
// byte of SHA-256(entropy) as checksum, read as 24 groups of 11 bits. False on NULL.
bool tk_seed_words(const uint8_t entropy[TK_SEED_ENTROPY_LEN], uint16_t idx[TK_SEED_WORDS]);

// The BIP39 English word for idx, or NULL if idx >= 2048.
const char *tk_seed_word(uint16_t idx);

// "word word ... word" into out. Returns the length without the NUL, or 0 on NULL, an index
// >= 2048 or cap < TK_SEED_MNEMONIC_MAX (nothing is written then).
size_t tk_seed_mnemonic(const uint16_t idx[TK_SEED_WORDS], char *out, size_t cap);

// BIP39 seed: PBKDF2-HMAC-SHA512(mnemonic, "mnemonic" || passphrase, 2048, 64). The device always
// passes "" (no passphrase); the parameter exists so published vectors (passphrase "TREZOR") can
// be tested. The mnemonic is built in a local buffer and wiped. False on NULL or a bad index.
bool tk_seed_bip39(const uint16_t idx[TK_SEED_WORDS], const char *passphrase, uint8_t seed[TK_SEED_LEN]);

// SLIP-10 Ed25519: master = HMAC-SHA512("ed25519 seed", seed); each step is
// HMAC-SHA512(chain, 0x00 || key || ser32(index)). Ed25519 has only hardened derivation, so any
// index without TK_SLIP10_HARDENED is refused (false, key zeroed). path may be empty (the master).
bool tk_slip10_ed25519(const uint8_t *seed, size_t seed_len, const uint32_t *path, size_t path_len,
                       uint8_t key[TK_SEED_KEY_LEN]);

#endif
