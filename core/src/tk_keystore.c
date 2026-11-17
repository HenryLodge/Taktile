// Key store. See tk_keystore.h.

#include "tk_keystore.h"

#include <string.h>

#include "ed25519.h"
#include "hmac.h"
#include "memzero.h"
#include "pbkdf2.h"
#include "tk_util.h"

#define OFF_VERSION 4u
#define OFF_ITERS 5u
#define OFF_SALT 9u
#define OFF_PUBKEY 25u
#define OFF_CT 57u
#define OFF_TAG 89u
#define VERSION 1u

static const uint8_t MAGIC[4] = {'T', 'K', 'W', '1'};
static const char ENC_LABEL[] = "TK-SEED-v1"; // no NUL in the HMAC

static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void wr32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static bool iters_ok(uint32_t iters) {
    return iters >= TK_KDF_ITERS_MIN && iters <= TK_KDF_ITERS_MAX;
}

static bool header_ok(const uint8_t *blob, size_t len) {
    return blob != NULL && len == TK_KEYSTORE_BLOB_LEN && memcmp(blob, MAGIC, sizeof(MAGIC)) == 0 &&
           blob[OFF_VERSION] == VERSION && iters_ok(rd32(blob + OFF_ITERS));
}

static bool pin_ok(const uint8_t pin[TK_PIN_LEN]) {
    if (pin == NULL) {
        return false;
    }
    for (size_t i = 0; i < TK_PIN_LEN; i++) {
        if (pin[i] > 9) {
            return false;
        }
    }
    return true;
}

// keystream = HMAC(Kenc, label), mac_key = Kmac, from the PIN and salt.
static void derive(const uint8_t pin[TK_PIN_LEN], const uint8_t *salt, uint32_t iters, uint8_t keystream[32],
                   uint8_t mac_key[32]) {
    uint8_t ascii[TK_PIN_LEN];
    for (size_t i = 0; i < TK_PIN_LEN; i++) {
        ascii[i] = (uint8_t)('0' + pin[i]);
    }
    uint8_t k[64];
    pbkdf2_hmac_sha256(ascii, TK_PIN_LEN, salt, TK_KEYSTORE_SALT_LEN, iters, k, sizeof(k));
    hmac_sha256(k, 32, (const uint8_t *)ENC_LABEL, (uint32_t)(sizeof(ENC_LABEL) - 1), keystream);
    memcpy(mac_key, k + 32, 32);
    memzero(k, sizeof(k));
    memzero(ascii, sizeof(ascii));
}

bool tk_keystore_seal(const uint8_t pin[TK_PIN_LEN], const uint8_t sk[32], const uint8_t pubkey[32],
                      const uint8_t salt[TK_KEYSTORE_SALT_LEN], uint32_t iters,
                      uint8_t blob[TK_KEYSTORE_BLOB_LEN]) {
    if (!pin_ok(pin) || sk == NULL || pubkey == NULL || salt == NULL || blob == NULL || !iters_ok(iters)) {
        return false;
    }
    memcpy(blob, MAGIC, sizeof(MAGIC));
    blob[OFF_VERSION] = VERSION;
    wr32(blob + OFF_ITERS, iters);
    memcpy(blob + OFF_SALT, salt, TK_KEYSTORE_SALT_LEN);
    memcpy(blob + OFF_PUBKEY, pubkey, 32);

    uint8_t ks[32], mk[32];
    derive(pin, salt, iters, ks, mk);
    for (size_t i = 0; i < 32; i++) {
        blob[OFF_CT + i] = (uint8_t)(sk[i] ^ ks[i]);
    }
    hmac_sha256(mk, sizeof(mk), blob, OFF_TAG, blob + OFF_TAG);
    memzero(ks, sizeof(ks));
    memzero(mk, sizeof(mk));
    return true;
}

tk_keystore_open_t tk_keystore_open(const uint8_t *blob, size_t len, const uint8_t pin[TK_PIN_LEN], uint8_t sk[32]) {
    if (sk == NULL) {
        return TK_KEYSTORE_OPEN_BAD_BLOB;
    }
    memzero(sk, 32);
    if (!header_ok(blob, len) || !pin_ok(pin)) {
        return TK_KEYSTORE_OPEN_BAD_BLOB;
    }
    uint8_t ks[32], mk[32], tag[32];
    derive(pin, blob + OFF_SALT, rd32(blob + OFF_ITERS), ks, mk);
    hmac_sha256(mk, sizeof(mk), blob, OFF_TAG, tag);
    tk_keystore_open_t r = TK_KEYSTORE_OPEN_WRONG_PIN;
    if (tk_ct_equal(tag, blob + OFF_TAG, sizeof(tag))) {
        for (size_t i = 0; i < 32; i++) {
            sk[i] = (uint8_t)(blob[OFF_CT + i] ^ ks[i]);
        }
        ed25519_public_key pub;
        ed25519_publickey(sk, pub);
        r = tk_ct_equal(pub, blob + OFF_PUBKEY, sizeof(pub)) ? TK_KEYSTORE_OPEN_OK : TK_KEYSTORE_OPEN_BAD_BLOB;
        if (r != TK_KEYSTORE_OPEN_OK) {
            memzero(sk, 32);
        }
    }
    memzero(ks, sizeof(ks));
    memzero(mk, sizeof(mk));
    memzero(tag, sizeof(tag));
    return r;
}

void tk_keystore_init(tk_keystore_t *ks, const tk_platform_t *platform) {
    memzero(ks, sizeof(*ks));
    ks->platform = platform;
    uint8_t buf[TK_KEYSTORE_BLOB_LEN + 1];
    size_t len = sizeof(buf);
    if (!platform->storage_get(platform->ctx, TK_STORAGE_WALLET, buf, &len) || len == 0) {
        ks->state = TK_KEYSTORE_EMPTY;
        return;
    }
    if (!header_ok(buf, len)) {
        ks->state = TK_KEYSTORE_CORRUPT; // never treated as "no wallet" (I10)
        return;
    }
    memcpy(ks->blob, buf, TK_KEYSTORE_BLOB_LEN);
    memcpy(ks->pubkey, buf + OFF_PUBKEY, 32);
    ks->state = TK_KEYSTORE_READY;
}

void tk_keystore_lock(tk_keystore_t *ks) {
    memzero(ks->sk, sizeof(ks->sk));
    ks->unlocked = false;
}

// ---- tk_wallet_ops_t ----

static bool k_has(void *ctx) {
    return ((tk_keystore_t *)ctx)->state != TK_KEYSTORE_EMPTY;
}

static bool k_pubkey(void *ctx, uint8_t out[32]) {
    tk_keystore_t *ks = ctx;
    if (ks->state != TK_KEYSTORE_READY) {
        return false;
    }
    memcpy(out, ks->pubkey, 32);
    return true;
}

static bool k_unlocked(void *ctx) {
    tk_keystore_t *ks = ctx;
    return ks->state == TK_KEYSTORE_READY && ks->unlocked;
}

static tk_unlock_result_t k_unlock(void *ctx, const uint8_t pin[TK_PIN_LEN], uint8_t *attempts_left) {
    (void)ctx;
    (void)pin;
    (void)attempts_left;
    // Fail closed until the PIN-unlock task adds the attempt counter (persisted before the check)
    // and the 10-failure wipe (I7).
    return TK_UNLOCK_ERROR;
}

static bool k_sign(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[TK_SIGNATURE_LEN]) {
    tk_keystore_t *ks = ctx;
    if (!k_unlocked(ks) || sig == NULL || (msg == NULL && len > 0)) {
        return false;
    }
    ed25519_sign(msg, len, ks->sk, sig);
    return true;
}

static bool k_create(void *ctx, const uint8_t pin[TK_PIN_LEN], const uint8_t sk[32], const uint8_t pubkey[32]) {
    tk_keystore_t *ks = ctx;
    const tk_platform_t *p = ks->platform;
    if (ks->state != TK_KEYSTORE_EMPTY || !pin_ok(pin) || sk == NULL || pubkey == NULL) {
        return false; // never replaces a wallet (I10)
    }
    uint8_t salt[TK_KEYSTORE_SALT_LEN];
    uint8_t blob[TK_KEYSTORE_BLOB_LEN];
    uint8_t back[TK_KEYSTORE_BLOB_LEN + 1];
    bool ok = p->random_bytes(p->ctx, salt, sizeof(salt)) &&
              tk_keystore_seal(pin, sk, pubkey, salt, TK_KDF_ITERS, blob);
    if (ok) {
        static const uint8_t zero = 0;
        ok = p->storage_set(p->ctx, TK_STORAGE_PIN_FAILS, &zero, 1); // counter first
    }
    bool wrote = false;
    if (ok) {
        wrote = true;
        size_t len = sizeof(back);
        ok = p->storage_set(p->ctx, TK_STORAGE_WALLET, blob, sizeof(blob)) &&
             p->storage_get(p->ctx, TK_STORAGE_WALLET, back, &len) && len == sizeof(blob) &&
             memcmp(back, blob, sizeof(blob)) == 0;
    }
    if (ok) {
        memcpy(ks->blob, blob, sizeof(blob));
        memcpy(ks->pubkey, pubkey, 32);
        memcpy(ks->sk, sk, 32);
        ks->state = TK_KEYSTORE_READY;
        ks->unlocked = true;
    } else if (wrote) {
        // Best effort: drop what this call may have written. Only ever our own new blob, because
        // create runs only when no wallet was stored.
        (void)p->storage_set(p->ctx, TK_STORAGE_WALLET, NULL, 0);
    }
    memzero(salt, sizeof(salt));
    memzero(back, sizeof(back));
    memzero(blob, sizeof(blob));
    return ok;
}

void tk_keystore_ops(tk_keystore_t *ks, tk_wallet_ops_t *ops) {
    ops->ctx = ks;
    ops->has_wallet = k_has;
    ops->get_pubkey = k_pubkey;
    ops->is_unlocked = k_unlocked;
    ops->unlock = k_unlock;
    ops->sign = k_sign;
    ops->create = k_create;
}
