#include <stdlib.h>

#include "tk_parser.h"
#include "tk_parser_vectors.h"
#include "tk_test.h"

static const uint8_t ZERO_TX[sizeof(tk_tx_t)];

// Copy into a heap buffer of exactly len bytes so ASan flags any read past the end. (The vector
// arrays sit next to each other in .rodata, which would hide a one-byte over-read.)
static tk_parse_result_t parse_exact(const uint8_t *msg, size_t len, const uint8_t *device,
                                     const uint8_t *ata, tk_tx_t *out) {
    uint8_t *copy = malloc(len > 0 ? len : 1);
    if (copy == NULL) {
        abort();
    }
    if (len > 0) {
        memcpy(copy, msg, len);
    }
    const tk_parse_result_t r = tk_parse_message(len > 0 ? copy : NULL, len, device, ata, out);
    free(copy);
    return r;
}

static void check_out_zero(const tk_tx_t *tx) {
    TK_CHECK(memcmp(tx, ZERO_TX, sizeof(*tx)) == 0);
}

static void test_vectors(void) {
    size_t ok = 0;
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        const tk_parser_vector_t *v = &tk_parser_vectors[i];
        tk_tx_t tx;
        const tk_parse_result_t r = parse_exact(v->msg, v->msg_len, v->device_pubkey, v->device_usdc_ata, &tx);
        if (r != v->reason) {
            fprintf(stderr, "vector %s: got reason %d, want %d\n", v->name, (int)r, (int)v->reason);
        }
        TK_CHECK(r == v->reason);
        TK_CHECK(tk_parse_status(r) == v->status);
        if (v->status == TK_STATUS_OK) {
            ok++;
            const tk_tx_kind_t want = v->kind == TK_VEC_KIND_SOL ? TK_TX_SOL : TK_TX_USDC;
            TK_CHECK(tx.kind == want);
            TK_CHECK(tx.amount == v->amount);
            TK_CHECK_MEM(tx.destination, v->destination, TK_PUBKEY_LEN);
        } else {
            check_out_zero(&tx);
        }
    }
    TK_CHECK(ok >= 6);
    TK_CHECK(TK_PARSER_VECTOR_COUNT >= 80);
}

static void test_compact_u16(void) {
    static const struct {
        const char *hex;
        tk_parse_result_t r;
        uint16_t value;
        size_t used;
    } cases[] = {
        {"00", TK_PARSE_OK, 0x0000, 1},
        {"7f", TK_PARSE_OK, 0x007f, 1},
        {"8001", TK_PARSE_OK, 0x0080, 2},
        {"ff7f", TK_PARSE_OK, 0x3fff, 2},
        {"808001", TK_PARSE_OK, 0x4000, 3},
        {"ffff03", TK_PARSE_OK, 0xffff, 3},
        {"0500", TK_PARSE_OK, 0x0005, 1}, // trailing byte belongs to the next field
        {"8000", TK_PARSE_BAD_COMPACT_U16, 0, 0},   // alias of 0
        {"8300", TK_PARSE_BAD_COMPACT_U16, 0, 0},   // alias of 3
        {"808000", TK_PARSE_BAD_COMPACT_U16, 0, 0}, // alias of 0
        {"ff8000", TK_PARSE_BAD_COMPACT_U16, 0, 0}, // alias of 0x7f
        {"ffff04", TK_PARSE_BAD_COMPACT_U16, 0, 0}, // > 0xffff
        {"ffff83", TK_PARSE_BAD_COMPACT_U16, 0, 0}, // continuation on byte 3
        {"80808000", TK_PARSE_BAD_COMPACT_U16, 0, 0},
        {"", TK_PARSE_TRUNCATED, 0, 0},
        {"80", TK_PARSE_TRUNCATED, 0, 0},
        {"ff80", TK_PARSE_TRUNCATED, 0, 0},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        uint8_t buf[4] = {0};
        const size_t n = strlen(cases[i].hex) / 2;
        tk_hex(cases[i].hex, buf, n);
        uint16_t value = 0xAAAA;
        size_t used = 99;
        const tk_parse_result_t r = tk_compact_u16_read(buf, n, &value, &used);
        if (r != cases[i].r) {
            fprintf(stderr, "compact-u16 \"%s\": got %d\n", cases[i].hex, (int)r);
        }
        TK_CHECK(r == cases[i].r);
        if (cases[i].r == TK_PARSE_OK) {
            TK_CHECK(value == cases[i].value);
            TK_CHECK(used == cases[i].used);
        }
    }
    // Every value round-trips through its canonical encoding, and only that one.
    for (uint32_t v = 0; v <= 0xFFFFu; v++) {
        uint8_t buf[3];
        size_t n = 0;
        uint32_t x = v;
        do {
            buf[n] = (uint8_t)(x & 0x7Fu);
            x >>= 7;
            if (x != 0) {
                buf[n] |= 0x80u;
            }
            n++;
        } while (x != 0);
        uint16_t value = 0;
        size_t used = 0;
        if (tk_compact_u16_read(buf, n, &value, &used) != TK_PARSE_OK || value != v || used != n) {
            fprintf(stderr, "compact-u16 round trip failed at %u\n", (unsigned)v);
            tk_test_failures++;
            break;
        }
    }
}

static void test_args(void) {
    tk_tx_t tx;
    memset(&tx, 0x5A, sizeof(tx));
    const tk_parser_vector_t *v = &tk_parser_vectors[0];
    TK_CHECK(tk_parse_message(NULL, 0, v->device_pubkey, v->device_usdc_ata, &tx) == TK_PARSE_TRUNCATED);
    check_out_zero(&tx);
    TK_CHECK(tk_parse_message(NULL, 5, v->device_pubkey, v->device_usdc_ata, &tx) != TK_PARSE_OK);
    TK_CHECK(tk_parse_message(v->msg, v->msg_len, NULL, v->device_usdc_ata, &tx) != TK_PARSE_OK);
    TK_CHECK(tk_parse_message(v->msg, v->msg_len, v->device_pubkey, NULL, &tx) != TK_PARSE_OK);
}

static void test_prefixes(void) {
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        const tk_parser_vector_t *v = &tk_parser_vectors[i];
        if (v->status != TK_STATUS_OK) {
            continue;
        }
        for (size_t cut = 0; cut < v->msg_len; cut++) {
            tk_tx_t tx;
            const tk_parse_result_t r = parse_exact(v->msg, cut, v->device_pubkey, v->device_usdc_ata, &tx);
            TK_CHECK(r != TK_PARSE_OK);
            check_out_zero(&tx);
        }
    }
}

// If a mutated message still parses, its outputs must be what the bytes actually say.
static void check_consistent(const uint8_t *msg, size_t len, const tk_tx_t *tx) {
    // Re-derive destination and amount the slow way: the last 12 (SOL) or 10 (USDC) bytes are the
    // instruction data, and the destination index sits just before the data length byte.
    const size_t data_len = tx->kind == TK_TX_SOL ? 12u : 10u;
    TK_CHECK(len > data_len + 2);
    const uint8_t *data = msg + len - data_len;
    uint64_t amount = 0;
    const size_t off = tx->kind == TK_TX_SOL ? 4u : 1u;
    for (size_t b = 0; b < 8; b++) {
        amount |= (uint64_t)data[off + b] << (8u * b);
    }
    TK_CHECK(amount == tx->amount);
    const uint8_t dest_index = tx->kind == TK_TX_SOL ? msg[len - data_len - 2] : msg[len - data_len - 3];
    TK_CHECK_MEM(tx->destination, msg + 4 + (size_t)dest_index * TK_PUBKEY_LEN, TK_PUBKEY_LEN);
}

static void test_single_byte_mutations(void) {
    size_t still_ok = 0;
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        const tk_parser_vector_t *v = &tk_parser_vectors[i];
        if (v->status != TK_STATUS_OK) {
            continue;
        }
        uint8_t buf[TK_MAX_MESSAGE_LEN];
        memcpy(buf, v->msg, v->msg_len);
        for (size_t pos = 0; pos < v->msg_len; pos++) {
            const uint8_t orig = buf[pos];
            for (unsigned val = 0; val < 256; val++) {
                if (val == orig) {
                    continue;
                }
                buf[pos] = (uint8_t)val;
                tk_tx_t tx;
                const tk_parse_result_t r = parse_exact(buf, v->msg_len, v->device_pubkey, v->device_usdc_ata, &tx);
                if (r == TK_PARSE_OK) {
                    still_ok++;
                    check_consistent(buf, v->msg_len, &tx);
                } else {
                    check_out_zero(&tx);
                }
            }
            buf[pos] = orig;
        }
    }
    // Amount and blockhash bytes may change freely, so some mutations must still parse.
    TK_CHECK(still_ok > 0);
}

static uint32_t rng_state = 0xC0FFEE11u;
static uint32_t rng(void) {
    uint32_t x = rng_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    rng_state = x;
    return x;
}

static void test_random(void) {
    const tk_parser_vector_t *base = NULL;
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        if (tk_parser_vectors[i].status == TK_STATUS_OK) {
            base = &tk_parser_vectors[i];
            break;
        }
    }
    TK_CHECK(base != NULL);
    if (base == NULL) {
        return;
    }
    static uint8_t buf[TK_MAX_MESSAGE_LEN + 16];
    for (int iter = 0; iter < TK_TEST_ITERS(20000); iter++) {
        size_t len;
        if (iter % 2 == 0) {
            // Plausible: start from a valid message, then corrupt a few bytes and maybe resize.
            len = base->msg_len;
            memcpy(buf, base->msg, len);
            const int flips = 1 + (int)(rng() % 6);
            for (int f = 0; f < flips; f++) {
                buf[rng() % len] = (uint8_t)rng();
            }
            len = (rng() % 4 == 0) ? (size_t)(rng() % (sizeof(buf))) : len;
        } else {
            // Raw noise with a legacy-looking header and small counts.
            len = rng() % sizeof(buf);
            for (size_t b = 0; b < len; b++) {
                buf[b] = (uint8_t)rng();
            }
            if (len >= 4) {
                buf[0] = 1;
                buf[1] = 0;
                buf[2] = (uint8_t)(rng() % 3);
                buf[3] = (uint8_t)(rng() % 8);
            }
        }
        tk_tx_t tx;
        const tk_parse_result_t r = parse_exact(buf, len, base->device_pubkey, base->device_usdc_ata, &tx);
        if (r != TK_PARSE_OK) {
            check_out_zero(&tx);
        }
    }
}

int main(void) {
    test_compact_u16();
    test_vectors();
    test_args();
    test_prefixes();
    test_single_byte_mutations();
    test_random();
    return tk_test_result();
}
