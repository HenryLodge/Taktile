// BIP39 + SLIP-10 Ed25519. See tk_seed.h.

#include "tk_seed.h"

#include <string.h>

#include "bip39.h"
#include "hmac.h"
#include "memzero.h"
#include "sha2.h"

const uint32_t TK_SOLANA_PATH[TK_SOLANA_PATH_LEN] = {
    44u | TK_SLIP10_HARDENED,
    501u | TK_SLIP10_HARDENED,
    0u | TK_SLIP10_HARDENED,
    0u | TK_SLIP10_HARDENED,
};

static const char ENT_TAG[] = "TK-ENT-v1";      // no NUL in the hash
static const char SLIP10_KEY[] = "ed25519 seed"; // SLIP-0010 curve key for Ed25519

void tk_seed_mix_entropy(const uint8_t hw[TK_SEED_ENTROPY_LEN], const uint8_t timing[32],
                         uint8_t out[TK_SEED_ENTROPY_LEN]) {
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, (const uint8_t *)ENT_TAG, sizeof(ENT_TAG) - 1);
    sha256_Update(&ctx, hw, TK_SEED_ENTROPY_LEN);
    sha256_Update(&ctx, timing, 32);
    sha256_Final(&ctx, out); // also wipes ctx
}

bool tk_seed_words(const uint8_t entropy[TK_SEED_ENTROPY_LEN], uint16_t idx[TK_SEED_WORDS]) {
    if (entropy == NULL || idx == NULL) {
        return false;
    }
    // 33 bytes = 264 bits = 24 x 11: the entropy, then the checksum byte.
    uint8_t bits[TK_SEED_ENTROPY_LEN + 1];
    memcpy(bits, entropy, TK_SEED_ENTROPY_LEN);
    uint8_t h[SHA256_DIGEST_LENGTH];
    sha256_Raw(entropy, TK_SEED_ENTROPY_LEN, h);
    bits[TK_SEED_ENTROPY_LEN] = h[0];
    for (size_t w = 0; w < TK_SEED_WORDS; w++) {
        uint16_t v = 0;
        for (size_t b = 0; b < 11; b++) {
            const size_t bit = w * 11 + b; // < 264
            v = (uint16_t)((v << 1) | ((bits[bit / 8] >> (7 - bit % 8)) & 1u));
        }
        idx[w] = v;
    }
    memzero(bits, sizeof(bits));
    memzero(h, sizeof(h));
    return true;
}

const char *tk_seed_word(uint16_t idx) {
    return idx < TK_SEED_WORD_COUNT ? BIP39_WORDLIST_ENGLISH[idx] : NULL;
}

size_t tk_seed_mnemonic(const uint16_t idx[TK_SEED_WORDS], char *out, size_t cap) {
    if (idx == NULL || out == NULL || cap < TK_SEED_MNEMONIC_MAX) {
        return 0;
    }
    for (size_t w = 0; w < TK_SEED_WORDS; w++) {
        if (idx[w] >= TK_SEED_WORD_COUNT) {
            return 0;
        }
    }
    size_t n = 0;
    for (size_t w = 0; w < TK_SEED_WORDS; w++) {
        const char *word = BIP39_WORDLIST_ENGLISH[idx[w]];
        const size_t len = strlen(word); // 3..8 for the English list
        if (w > 0) {
            out[n++] = ' ';
        }
        // Each word adds at most 9 bytes with its space; the cap check above leaves room for all
        // 24 plus the NUL. Stay defensive anyway.
        if (n + len + 1 > cap) {
            memzero(out, cap);
            return 0;
        }
        memcpy(out + n, word, len);
        n += len;
    }
    out[n] = '\0';
    return n;
}

bool tk_seed_bip39(const uint16_t idx[TK_SEED_WORDS], const char *passphrase, uint8_t seed[TK_SEED_LEN]) {
    if (idx == NULL || passphrase == NULL || seed == NULL) {
        return false;
    }
    char mnemonic[TK_SEED_MNEMONIC_MAX];
    const bool ok = tk_seed_mnemonic(idx, mnemonic, sizeof(mnemonic)) > 0;
    if (ok) {
        mnemonic_to_seed(mnemonic, passphrase, seed, NULL);
    }
    memzero(mnemonic, sizeof(mnemonic));
    return ok;
}

bool tk_slip10_ed25519(const uint8_t *seed, size_t seed_len, const uint32_t *path, size_t path_len,
                       uint8_t key[TK_SEED_KEY_LEN]) {
    if (key == NULL) {
        return false;
    }
    memzero(key, TK_SEED_KEY_LEN);
    if (seed == NULL || seed_len == 0 || seed_len > UINT32_MAX || (path == NULL && path_len > 0)) {
        return false;
    }
    for (size_t i = 0; i < path_len; i++) {
        if ((path[i] & TK_SLIP10_HARDENED) == 0) {
            return false; // Ed25519: hardened only
        }
    }

    uint8_t I[SHA512_DIGEST_LENGTH]; // IL = key, IR = chain code
    hmac_sha512((const uint8_t *)SLIP10_KEY, (uint32_t)(sizeof(SLIP10_KEY) - 1), seed, (uint32_t)seed_len, I);

    uint8_t data[1 + TK_SEED_KEY_LEN + 4];
    uint8_t chain[32];
    for (size_t i = 0; i < path_len; i++) {
        data[0] = 0x00;
        memcpy(data + 1, I, TK_SEED_KEY_LEN);
        data[33] = (uint8_t)(path[i] >> 24);
        data[34] = (uint8_t)(path[i] >> 16);
        data[35] = (uint8_t)(path[i] >> 8);
        data[36] = (uint8_t)path[i];
        memcpy(chain, I + 32, sizeof(chain));
        hmac_sha512(chain, sizeof(chain), data, sizeof(data), I);
    }
    memcpy(key, I, TK_SEED_KEY_LEN);
    memzero(I, sizeof(I));
    memzero(data, sizeof(data));
    memzero(chain, sizeof(chain));
    return true;
}
