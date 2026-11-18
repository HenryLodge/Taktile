// The device's key store: the wallet's Ed25519 key, encrypted under the PIN, in platform storage
// (plain NVS on the device; SECURITY_MODEL I7). Implements tk_wallet_ops_t for the flows.
//
// Storage key "wallet" holds one 121-byte blob (little-endian), written in one storage_set:
//
//    0 "TKW1"   4 version u8 (1)   5 kdf_iters u32   9 salt[16]   25 pubkey[32]   57 ct[32]   89 tag[32]
//
//   K    = PBKDF2-HMAC-SHA256(PIN as 6 ASCII digits, salt, kdf_iters, 64 bytes)
//   Kenc = K[0..32), Kmac = K[32..64)
//   ct   = sk XOR HMAC-SHA256(Kenc, "TK-SEED-v1")       (salt is fresh per wallet: no keystream reuse)
//   tag  = HMAC-SHA256(Kmac, blob[0..89))
//
// A wrong PIN fails the tag check (constant time); after decryption the key must also give pubkey.
// Storage key "pin-fails" (u8) is the failed-attempt counter, written 0 before "wallet" at create.
//
// Unlock (I7): the counter is incremented and committed BEFORE the PIN is checked, so cutting power
// during the check still counts the attempt. A storage problem fails closed (TK_UNLOCK_ERROR, PIN
// not checked). After TK_PIN_MAX_FAILS failures the wallet is wiped: "wallet" cleared first, then
// RAM, then the counter reset; tk_keystore_init finishes a wipe that a power cut interrupted.
//
// Auto-lock: after every signature, TK_AUTOLOCK_MS after an unlock, on the lock op (USB host lost),
// and at every boot (the key is in RAM only).

#ifndef TK_KEYSTORE_H
#define TK_KEYSTORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tk_platform.h"
#include "tk_wallet.h"

#define TK_KDF_ITERS 20000u     // SECURITY_MODEL I7 (measured on device)
#define TK_KDF_ITERS_MIN 1000u  // a stored count outside [MIN, MAX] makes the blob corrupt
#define TK_KDF_ITERS_MAX 1000000u
#define TK_KEYSTORE_SALT_LEN 16u
#define TK_KEYSTORE_BLOB_LEN 121u
#define TK_PIN_MAX_FAILS 10u      // I7: this many wrong PINs in a row wipe the wallet
#define TK_AUTOLOCK_MS 300000u    // an unlock lasts at most 5 minutes (and only until the next signature)

#define TK_STORAGE_WALLET "wallet"
#define TK_STORAGE_PIN_FAILS "pin-fails"

typedef enum {
    TK_KEYSTORE_EMPTY = 0, // no wallet: SETUP may create one
    TK_KEYSTORE_READY,     // a well-formed wallet (locked or unlocked)
    TK_KEYSTORE_CORRUPT,   // something unreadable is stored: counts as a wallet (I10), never unlocks
} tk_keystore_state_t;

typedef struct {
    const tk_platform_t *platform;
    tk_keystore_state_t state;
    bool unlocked;
    uint8_t blob[TK_KEYSTORE_BLOB_LEN]; // READY: the stored blob
    uint8_t pubkey[32];                 // READY
    uint8_t sk[32];                     // only while unlocked; wiped by tk_keystore_lock
    uint32_t unlocked_at;               // now_ms when the session began
} tk_keystore_t;

typedef enum {
    TK_KEYSTORE_OPEN_OK = 0,
    TK_KEYSTORE_OPEN_WRONG_PIN, // tag mismatch
    TK_KEYSTORE_OPEN_BAD_BLOB,  // wrong length or header, or the key doesn't match pubkey
} tk_keystore_open_t;

// Loads "wallet" from storage. Missing or zero-length: EMPTY. Wrong length, magic, version or
// iteration count: CORRUPT. Always starts locked. If "pin-fails" is already at TK_PIN_MAX_FAILS (a
// lockout wipe was cut short), finishes the wipe first.
void tk_keystore_init(tk_keystore_t *ks, const tk_platform_t *platform);

// The flows' view (tk_wallet_ops_t) with ctx = ks.
void tk_keystore_ops(tk_keystore_t *ks, tk_wallet_ops_t *ops);

// Forget the key (memzero); the wallet stays stored.
void tk_keystore_lock(tk_keystore_t *ks);

// The lockout wipe (I7): clear "wallet" in storage, wipe RAM (state EMPTY), reset "pin-fails".
// False if "wallet" could not be cleared: then the state is CORRUPT (never unlocks, never replaced).
// The caller wipes the contact book.
bool tk_keystore_wipe(tk_keystore_t *ks);

// Pure helpers (no storage, no RNG). seal: false on a PIN digit > 9, iterations out of range or NULL.
bool tk_keystore_seal(const uint8_t pin[TK_PIN_LEN], const uint8_t sk[32], const uint8_t pubkey[32],
                      const uint8_t salt[TK_KEYSTORE_SALT_LEN], uint32_t iters,
                      uint8_t blob[TK_KEYSTORE_BLOB_LEN]);
// On OK, sk receives the key; otherwise sk is zeroed.
tk_keystore_open_t tk_keystore_open(const uint8_t *blob, size_t len, const uint8_t pin[TK_PIN_LEN], uint8_t sk[32]);

#endif
