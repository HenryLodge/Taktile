// The key store as the request flows see it. Implemented by the SETUP / PIN-unlock tasks
// (PBKDF2-encrypted seed, attempt counter persisted before each check, wipe at 10 failures: I7).

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
} tk_unlock_result_t;

typedef struct {
    void *ctx;
    bool (*has_wallet)(void *ctx);
    bool (*get_pubkey)(void *ctx, uint8_t out[32]);
    bool (*is_unlocked)(void *ctx);
    tk_unlock_result_t (*unlock)(void *ctx, const uint8_t pin[TK_PIN_LEN], uint8_t *attempts_left);
    // Ed25519 signature over msg. Must refuse (return false) unless unlocked.
    bool (*sign)(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[TK_SIGNATURE_LEN]);
} tk_wallet_ops_t;

#endif
