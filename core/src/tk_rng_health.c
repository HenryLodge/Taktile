#include "tk_rng_health.h"

#define BITS_EXPECTED (TK_RNG_STARTUP_LEN * 8u / 2u) // 2048
#define BITS_TOLERANCE 192u                          // sigma = sqrt(4096)/2 = 32; 6 sigma
#define MAX_BYTE_COUNT 16u                           // expected 512/256 = 2

static uint32_t word_at(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint32_t popcount8(uint8_t b) {
    uint32_t n = 0;
    while (b != 0) {
        n += b & 1u;
        b >>= 1;
    }
    return n;
}

bool tk_rng_startup_ok(const uint8_t *buf, size_t len) {
    if (buf == NULL || len != TK_RNG_STARTUP_LEN) {
        return false;
    }

    for (size_t i = 4; i + 4 <= len; i += 4) {
        if (word_at(buf + i) == word_at(buf + i - 4)) {
            return false;
        }
    }

    uint32_t ones = 0;
    uint16_t counts[256] = {0};
    for (size_t i = 0; i < len; i++) {
        ones += popcount8(buf[i]);
        if (++counts[buf[i]] > MAX_BYTE_COUNT) {
            return false;
        }
    }
    return ones >= BITS_EXPECTED - BITS_TOLERANCE && ones <= BITS_EXPECTED + BITS_TOLERANCE;
}

void tk_rng_cont_init(tk_rng_cont_t *st) {
    st->last = 0;
    st->have_last = false;
    st->failed = false;
}

bool tk_rng_cont_next(tk_rng_cont_t *st, uint32_t word) {
    if (st->have_last && word == st->last) {
        st->failed = true;
    }
    st->last = word;
    st->have_last = true;
    return !st->failed;
}
