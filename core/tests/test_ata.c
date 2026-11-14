// ATA derivation tests against @solana/spl-token getAssociatedTokenAddressSync (tests/vectors/ata.json)
// and the on-curve check against web3.js PublicKey.isOnCurve (tests/vectors/curve.json).

#include "tk_ata.h"
#include "tk_ata_vectors.h"
#include "tk_curve_vectors.h"
#include "tk_parser_vectors.h"
#include "tk_test.h"

static const uint8_t ZERO[TK_PUBKEY_LEN];

static void test_vectors(void) {
    int deep = 0, other_mint = 0;
    for (size_t i = 0; i < TK_ATA_VECTOR_COUNT; i++) {
        const tk_ata_vector_t *v = &tk_ata_vectors[i];
        uint8_t ata[TK_PUBKEY_LEN];
        uint8_t bump = 0;
        const bool ok = tk_ata_derive(v->wallet, v->mint, ata, &bump);
        if (!ok || bump != v->bump || memcmp(ata, v->ata, TK_PUBKEY_LEN) != 0) {
            fprintf(stderr, "ata vector %s: ok=%d bump=%u want %u\n", v->name, ok, bump, v->bump);
        }
        TK_CHECK(ok);
        TK_CHECK(bump == v->bump);
        TK_CHECK_MEM(ata, v->ata, TK_PUBKEY_LEN);

        // The loop stopped at the right bump for the right reason: every higher bump gave a point
        // on the curve, and the accepted address is off it.
        for (int b = 255; b > v->bump; b--) {
            uint8_t h[TK_PUBKEY_LEN];
            tk_ata_candidate(v->wallet, v->mint, (uint8_t)b, h);
            TK_CHECK(tk_ed25519_on_curve(h));
        }
        TK_CHECK(!tk_ed25519_on_curve(v->ata));

        deep += v->bump <= 251;
        other_mint += memcmp(v->mint, TK_DEVNET_USDC_MINT, TK_PUBKEY_LEN) != 0;
    }
    TK_CHECK(TK_ATA_VECTOR_COUNT >= 10);
    TK_CHECK(deep >= 2);
    TK_CHECK(other_mint >= 2);
}

static void test_device_usdc_ata(void) {
    // The parser vectors take device_usdc_ata as an input; deriving it on device gives the same bytes.
    const tk_parser_vector_t *p = &tk_parser_vectors[0];
    uint8_t ata[TK_PUBKEY_LEN];
    uint8_t bump = 0;
    TK_CHECK(tk_ata_derive(p->device_pubkey, TK_DEVNET_USDC_MINT, ata, &bump));
    TK_CHECK_MEM(ata, p->device_usdc_ata, TK_PUBKEY_LEN);
}

static void test_curve_vectors(void) {
    int on = 0;
    for (size_t i = 0; i < TK_CURVE_VECTOR_COUNT; i++) {
        const tk_curve_vector_t *v = &tk_curve_vectors[i];
        const bool got = tk_ed25519_on_curve(v->bytes);
        if (got != v->on_curve) {
            fprintf(stderr, "curve vector %s: got %d, want %d\n", v->name, got, v->on_curve);
        }
        TK_CHECK(got == v->on_curve);
        on += v->on_curve;
    }
    TK_CHECK(on > 0 && on < (int)TK_CURVE_VECTOR_COUNT);
}

static void test_fixed_points(void) {
    static const struct {
        const char *hex;
        bool on_curve;
    } cases[] = {
        // ed25519 base point
        {"5866666666666666666666666666666666666666666666666666666666666666", true},
        // identity (x = 0, y = 1)
        {"0100000000000000000000000000000000000000000000000000000000000000", true},
        // Edge cases where the on-chain rule (curve25519-dalek decompress) is looser than web3.js:
        // x = 0 with the sign bit set, and y = p + 1 (non-canonical encoding of y = 1).
        {"0100000000000000000000000000000000000000000000000000000000000080", true},
        {"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", true},
        // y = 2 is not on the curve: (4 - 1) / (4d + 1) is not a square.
        {"0200000000000000000000000000000000000000000000000000000000000000", false},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        uint8_t p[TK_PUBKEY_LEN];
        tk_hex(cases[i].hex, p, sizeof(p));
        if (tk_ed25519_on_curve(p) != cases[i].on_curve) {
            fprintf(stderr, "fixed point %s: want %d\n", cases[i].hex, cases[i].on_curve);
        }
        TK_CHECK(tk_ed25519_on_curve(p) == cases[i].on_curve);
    }
    // Every wallet in the vectors is a real public key, so it is on the curve.
    for (size_t i = 0; i < TK_ATA_VECTOR_COUNT; i++) {
        TK_CHECK(tk_ed25519_on_curve(tk_ata_vectors[i].wallet));
    }
}

static void test_args(void) {
    const tk_ata_vector_t *v = &tk_ata_vectors[0];
    uint8_t ata[TK_PUBKEY_LEN];
    uint8_t bump = 7;
    memset(ata, 0xAA, sizeof(ata));
    TK_CHECK(!tk_ata_derive(NULL, v->mint, ata, &bump));
    TK_CHECK_MEM(ata, ZERO, TK_PUBKEY_LEN);
    memset(ata, 0xAA, sizeof(ata));
    TK_CHECK(!tk_ata_derive(v->wallet, NULL, ata, &bump));
    TK_CHECK_MEM(ata, ZERO, TK_PUBKEY_LEN);
    memset(ata, 0xAA, sizeof(ata));
    TK_CHECK(!tk_ata_derive(v->wallet, v->mint, ata, NULL));
    TK_CHECK_MEM(ata, ZERO, TK_PUBKEY_LEN);
    TK_CHECK(!tk_ata_derive(v->wallet, v->mint, NULL, &bump));
    TK_CHECK(bump == 7);
}

int main(void) {
    test_vectors();
    test_device_usdc_ata();
    test_curve_vectors();
    test_fixed_points();
    test_args();
    return tk_test_result();
}
