// libFuzzer target for tk_parse_message. The input is the raw message bytes.
//
// Besides crashes and sanitizer reports, it aborts if the parser breaks one of its promises:
// deterministic, *out zeroed on rejection, result in range, and on OK the outputs are exactly
// what the bytes say.

#include <stdlib.h>
#include <string.h>

#include "tk_parser.h"
#include "tk_parser_vectors.h"

#define REQUIRE(cond)    \
    do {                 \
        if (!(cond)) {   \
            abort();     \
        }                \
    } while (0)

static const uint8_t ZERO_TX[sizeof(tk_tx_t)];

// Same rule as check_consistent() in tests/test_parser.c. Valid messages have N < 128 (so N is
// one byte and keys start at offset 4) and end with the instruction data (no trailing bytes).
static void check_ok(const uint8_t *msg, size_t len, const tk_tx_t *tx) {
    REQUIRE(tx->kind == TK_TX_SOL || tx->kind == TK_TX_USDC);
    const size_t data_len = tx->kind == TK_TX_SOL ? 12u : 10u;
    REQUIRE(len > data_len + 3);
    const uint8_t *data = msg + len - data_len;
    const size_t off = tx->kind == TK_TX_SOL ? 4u : 1u;
    uint64_t amount = 0;
    for (size_t b = 0; b < 8; b++) {
        amount |= (uint64_t)data[off + b] << (8u * b);
    }
    REQUIRE(amount == tx->amount);
    const uint8_t dest = tx->kind == TK_TX_SOL ? msg[len - data_len - 2] : msg[len - data_len - 3];
    const size_t at = 4 + (size_t)dest * TK_PUBKEY_LEN;
    REQUIRE(at + TK_PUBKEY_LEN <= len);
    REQUIRE(memcmp(tx->destination, msg + at, TK_PUBKEY_LEN) == 0);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    // Every vector uses the same device, so seeds built from them can reach the OK paths.
    const tk_parser_vector_t *v = &tk_parser_vectors[0];

    tk_tx_t a, b;
    memset(&a, 0xA5, sizeof(a));
    memset(&b, 0x5A, sizeof(b));
    const tk_parse_result_t ra = tk_parse_message(data, size, v->device_pubkey, v->device_usdc_ata, &a);
    const tk_parse_result_t rb = tk_parse_message(data, size, v->device_pubkey, v->device_usdc_ata, &b);

    REQUIRE(ra == rb);
    REQUIRE(memcmp(&a, &b, sizeof(a)) == 0);
    REQUIRE((int)ra >= (int)TK_PARSE_OK && (int)ra <= (int)TK_PARSE_TOKEN_OWNER_NOT_DEVICE);
    REQUIRE(tk_parse_status(ra) == (ra == TK_PARSE_OK ? TK_STATUS_OK : TK_STATUS_PARSE_UNSUPPORTED));
    if (ra == TK_PARSE_OK) {
        check_ok(data, size, &a);
    } else {
        REQUIRE(memcmp(&a, ZERO_TX, sizeof(a)) == 0);
    }

    uint16_t value = 0;
    size_t used = 0;
    const tk_parse_result_t rc = tk_compact_u16_read(data, size, &value, &used);
    REQUIRE(rc == TK_PARSE_OK || rc == TK_PARSE_TRUNCATED || rc == TK_PARSE_BAD_COMPACT_U16);
    if (rc == TK_PARSE_OK) {
        REQUIRE(used >= 1 && used <= 3 && used <= size);
    }
    return 0;
}
