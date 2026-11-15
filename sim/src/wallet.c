// INSECURE development wallet for the simulator, until the real key store exists (SETUP and
// PIN-unlock tasks). The seed is kept in plaintext in <data>/dev-seed. Devnet only, never real
// funds. It still follows the flow rules: sign() refuses unless unlocked, failures are counted
// before the PIN is compared, and 10 failures wipe the seed.

#include <stdio.h>
#include <string.h>

#include "ed25519.h"
#include "memzero.h"
#include "sim.h"
#include "util.h"

#define KEY_SEED "dev-seed"

static void save_seed(sim_wallet_t *w) {
    if (w->persist) {
        w->platform->storage_set(w->platform->ctx, KEY_SEED, w->has_wallet ? w->seed : NULL,
                                 w->has_wallet ? sizeof(w->seed) : 0);
    }
}

bool sim_wallet_init(sim_wallet_t *w, const tk_platform_t *p, const char *seed_hex, const char *pin, bool unlocked) {
    memset(w, 0, sizeof(*w));
    w->platform = p;
    if (pin == NULL) {
        pin = "123456";
    }
    if (strlen(pin) != TK_PIN_LEN) {
        fprintf(stderr, "--pin must be %u digits\n", TK_PIN_LEN);
        return false;
    }
    for (size_t i = 0; i < TK_PIN_LEN; i++) {
        if (pin[i] < '0' || pin[i] > '9') {
            fprintf(stderr, "--pin must be digits\n");
            return false;
        }
        w->pin[i] = (uint8_t)(pin[i] - '0');
    }
    if (seed_hex != NULL) {
        if (!sim_hex32(seed_hex, w->seed)) {
            fprintf(stderr, "--seed-hex must be 64 hex characters\n");
            return false;
        }
        w->has_wallet = true;
    } else {
        w->persist = true;
        size_t len = sizeof(w->seed);
        if (p->storage_get(p->ctx, KEY_SEED, w->seed, &len)) {
            w->has_wallet = len == sizeof(w->seed); // an empty file means wiped
        } else {
            if (!p->random_bytes(p->ctx, w->seed, sizeof(w->seed))) {
                fprintf(stderr, "RNG failed\n");
                return false;
            }
            w->has_wallet = true;
            save_seed(w);
        }
    }
    if (w->has_wallet) {
        ed25519_publickey(w->seed, w->pubkey);
        w->unlocked = unlocked;
    }
    return true;
}

static bool w_has(void *ctx) {
    return ((sim_wallet_t *)ctx)->has_wallet;
}

static bool w_pubkey(void *ctx, uint8_t out[32]) {
    sim_wallet_t *w = ctx;
    if (!w->has_wallet) {
        return false;
    }
    memcpy(out, w->pubkey, 32);
    return true;
}

static bool w_unlocked(void *ctx) {
    sim_wallet_t *w = ctx;
    return w->has_wallet && w->unlocked;
}

static tk_unlock_result_t w_unlock(void *ctx, const uint8_t pin[TK_PIN_LEN], uint8_t *left) {
    sim_wallet_t *w = ctx;
    if (!w->has_wallet) {
        return TK_UNLOCK_LOCKED_OUT;
    }
    w->failures++; // counted before comparing (I7); undone on success
    if (memcmp(pin, w->pin, TK_PIN_LEN) == 0) {
        w->failures = 0;
        w->unlocked = true;
        return TK_UNLOCK_OK;
    }
    if (w->failures >= SIM_MAX_PIN_FAILURES) {
        memzero(w->seed, sizeof(w->seed));
        memzero(w->pubkey, sizeof(w->pubkey));
        w->has_wallet = false;
        w->unlocked = false;
        save_seed(w);
        printf("[SIM] dev wallet wiped after %u wrong PINs\n", SIM_MAX_PIN_FAILURES);
        return TK_UNLOCK_LOCKED_OUT;
    }
    *left = (uint8_t)(SIM_MAX_PIN_FAILURES - w->failures);
    return TK_UNLOCK_WRONG;
}

static bool w_sign(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[TK_SIGNATURE_LEN]) {
    sim_wallet_t *w = ctx;
    if (!w->has_wallet || !w->unlocked) {
        return false;
    }
    ed25519_sign(msg, len, w->seed, sig);
    return true;
}

const tk_wallet_ops_t SIM_WALLET_OPS_TEMPLATE = {NULL, w_has, w_pubkey, w_unlocked, w_unlock, w_sign};
