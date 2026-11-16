#include "tk_rng_health.h"
#include "tk_test.h"

// splitmix64 with a fixed seed: a deterministic stand-in for good RNG output.
static uint64_t sm_state;
static uint64_t splitmix64(void) {
    uint64_t z = (sm_state += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

static void fill_good(uint8_t *buf) {
    sm_state = 0x54414B54494C4521ull; // fixed seed
    for (size_t i = 0; i < TK_RNG_STARTUP_LEN; i += 8) {
        const uint64_t v = splitmix64();
        for (size_t j = 0; j < 8; j++) {
            buf[i + j] = (uint8_t)(v >> (8 * j));
        }
    }
}

int main(void) {
    uint8_t buf[TK_RNG_STARTUP_LEN];

    // Good output passes.
    fill_good(buf);
    TK_CHECK(tk_rng_startup_ok(buf, sizeof(buf)));

    // Wrong length or NULL fails closed.
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf) - 1));
    TK_CHECK(!tk_rng_startup_ok(NULL, sizeof(buf)));

    // Stuck at zero / one.
    memset(buf, 0x00, sizeof(buf));
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf)));
    memset(buf, 0xFF, sizeof(buf));
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf)));

    // One repeated adjacent word anywhere fails.
    fill_good(buf);
    memcpy(buf + 300, buf + 296, 4);
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf)));

    // A 32-bit counter (0, 1, 2, ...): words never repeat, but almost every bit is zero.
    for (size_t i = 0; i < sizeof(buf); i += 4) {
        const uint32_t w = (uint32_t)(i / 4);
        buf[i] = (uint8_t)w;
        buf[i + 1] = (uint8_t)(w >> 8);
        buf[i + 2] = (uint8_t)(w >> 16);
        buf[i + 3] = (uint8_t)(w >> 24);
    }
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf)));

    // A short repeating pattern (period 31): balanced-looking bits, but each value appears ~16-17 times.
    for (size_t i = 0; i < sizeof(buf); i++) {
        buf[i] = (uint8_t)((i % 31) * 37u + 5u);
    }
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf)));

    // Biased: clear the top bit of every byte (7/16 ones instead of 1/2: about 1792 of 4096).
    fill_good(buf);
    for (size_t i = 0; i < sizeof(buf); i++) {
        buf[i] &= 0x7F;
    }
    TK_CHECK(!tk_rng_startup_ok(buf, sizeof(buf)));

    // Continuous test: distinct words pass, a repeat latches failure.
    tk_rng_cont_t st;
    tk_rng_cont_init(&st);
    TK_CHECK(tk_rng_cont_next(&st, 0));          // first word: nothing to compare against
    TK_CHECK(tk_rng_cont_next(&st, 1));
    TK_CHECK(tk_rng_cont_next(&st, 0xDEADBEEF));
    TK_CHECK(!tk_rng_cont_next(&st, 0xDEADBEEF)); // repeat
    TK_CHECK(!tk_rng_cont_next(&st, 7));          // stays failed
    TK_CHECK(st.failed);

    return tk_test_result();
}
