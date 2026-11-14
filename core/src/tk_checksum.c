#include "tk_checksum.h"

#include <string.h>

#include "memzero.h"
#include "sha2.h"

static const char TX_TAG[] = "TK-TX-v1";
static const char ADDR_TAG[] = "TK-ADDR-v1";

// SHA256(tag || data), first n bytes to out. The full hash is wiped afterwards (I2).
static void phrase(const char *tag, size_t tag_len, const uint8_t *data, size_t len, uint8_t *out,
                   size_t n) {
    uint8_t h[SHA256_DIGEST_LENGTH];
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, (const uint8_t *)tag, tag_len);
    if (len > 0) {
        sha256_Update(&ctx, data, len);
    }
    sha256_Final(&ctx, h); // also wipes ctx
    memcpy(out, h, n);
    memzero(h, sizeof(h));
}

void tk_checksum_tx(const uint8_t *msg, size_t len, uint8_t words[TK_TX_PHRASE_WORDS]) {
    phrase(TX_TAG, sizeof(TX_TAG) - 1, msg, len, words, TK_TX_PHRASE_WORDS);
}

void tk_checksum_addr(const uint8_t wallet[TK_PUBKEY_LEN], uint8_t words[TK_ADDR_PHRASE_WORDS]) {
    phrase(ADDR_TAG, sizeof(ADDR_TAG) - 1, wallet, TK_PUBKEY_LEN, words, TK_ADDR_PHRASE_WORDS);
}
