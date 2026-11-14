#include "tk_ata.h"

#include <string.h>

#include "sha2.h"

static const char PDA_MARKER[] = "ProgramDerivedAddress"; // hashed without the trailing NUL

void tk_ata_candidate(const uint8_t wallet[TK_PUBKEY_LEN], const uint8_t mint[TK_PUBKEY_LEN],
                      uint8_t bump, uint8_t out[TK_PUBKEY_LEN]) {
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, wallet, TK_PUBKEY_LEN);
    sha256_Update(&ctx, TK_TOKEN_PROGRAM_ID, TK_PUBKEY_LEN);
    sha256_Update(&ctx, mint, TK_PUBKEY_LEN);
    sha256_Update(&ctx, &bump, 1);
    sha256_Update(&ctx, TK_ATA_PROGRAM_ID, TK_PUBKEY_LEN);
    sha256_Update(&ctx, (const uint8_t *)PDA_MARKER, sizeof(PDA_MARKER) - 1);
    sha256_Final(&ctx, out); // also wipes ctx
}

bool tk_ata_derive(const uint8_t wallet[TK_PUBKEY_LEN], const uint8_t mint[TK_PUBKEY_LEN],
                   uint8_t ata[TK_PUBKEY_LEN], uint8_t *bump) {
    if (ata == NULL) {
        return false;
    }
    memset(ata, 0, TK_PUBKEY_LEN);
    if (wallet == NULL || mint == NULL || bump == NULL) {
        return false;
    }
    for (int b = 255; b >= 0; b--) {
        uint8_t h[TK_PUBKEY_LEN];
        tk_ata_candidate(wallet, mint, (uint8_t)b, h);
        if (!tk_ed25519_on_curve(h)) {
            memcpy(ata, h, TK_PUBKEY_LEN);
            *bump = (uint8_t)b;
            return true;
        }
    }
    return false;
}
