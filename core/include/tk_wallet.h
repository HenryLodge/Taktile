// The key store as the request flows see it. core/src/tk_keystore.c implements it (PBKDF2-encrypted
// key; the PIN-unlock task adds the attempt counter persisted before each check and the wipe: I7).

#ifndef TK_WALLET_H
#define TK_WALLET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TK_PIN_LEN 6u
#define TK_SIGNATURE_LEN 64u

typedef enum {
    TK_UNLOCK_OK = 0,
    TK_UNLOCK_WRONG,      // *attempts_left set
    TK_UNLOCK_LOCKED_OUT, // too many failures: the seed has been wiped
    TK_UNLOCK_ERROR,      // the key store can't check a PIN (storage, corrupt wallet): nothing unlocked
} tk_unlock_result_t;

typedef struct {
    void *ctx;
    bool (*has_wallet)(void *ctx);
    bool (*get_pubkey)(void *ctx, uint8_t out[32]);
    bool (*is_unlocked)(void *ctx);
    tk_unlock_result_t (*unlock)(void *ctx, const uint8_t pin[TK_PIN_LEN], uint8_t *attempts_left);
    // Ed25519 signature over msg. Must refuse (return false) unless unlocked. The key store locks
    // again after every signature.
    bool (*sign)(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[TK_SIGNATURE_LEN]);
    // SETUP's last step: store sk (with its public key) encrypted under pin, and stay unlocked.
    // Must refuse (return false, nothing stored) if a wallet exists (I10).
    bool (*create)(void *ctx, const uint8_t pin[TK_PIN_LEN], const uint8_t sk[32], const uint8_t pubkey[32]);
    // End the unlocked session now (the USB host went away). May be NULL.
    void (*lock)(void *ctx);
} tk_wallet_ops_t;

#endif
