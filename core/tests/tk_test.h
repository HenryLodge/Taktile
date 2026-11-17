// Minimal test harness: each test file is its own executable, registered with ctest.
// Failures are printed and counted; main returns tk_test_result() so ctest sees a non-zero exit.

#ifndef TK_TEST_H
#define TK_TEST_H

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int tk_test_failures = 0;

// Iteration count for the long seeded random loops. On the host, always n. In the device test app
// (firmware/test_app, built with TK_TEST_DEVICE) the runner sets the divisor: 20 for the default
// short run, 1 for a full run. The seeds are fixed, so a short run is exactly the start of a full one.
#ifdef TK_TEST_DEVICE
extern unsigned tk_test_iter_div;
#define TK_TEST_ITERS(n) ((int)((n) / tk_test_iter_div))
#else
#define TK_TEST_ITERS(n) (n)
#endif

#define TK_CHECK(cond)                                                    \
    do {                                                                  \
        if (!(cond)) {                                                    \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__,        \
                    __LINE__, #cond);                                     \
            tk_test_failures++;                                           \
        }                                                                 \
    } while (0)

#define TK_CHECK_MEM(actual, expected, len)                               \
    do {                                                                  \
        if (memcmp((actual), (expected), (len)) != 0) {                   \
            fprintf(stderr, "%s:%d: CHECK_MEM failed: %s != %s\n",        \
                    __FILE__, __LINE__, #actual, #expected);              \
            tk_test_failures++;                                           \
        }                                                                 \
    } while (0)

// Decode a hex string into out (exactly out_len bytes). Test-only helper; aborts the test on bad input.
static inline void tk_hex(const char *hex, uint8_t *out, size_t out_len) {
    if (strlen(hex) != out_len * 2) {
        fprintf(stderr, "tk_hex: length mismatch for \"%s\"\n", hex);
        tk_test_failures++;
        memset(out, 0, out_len);
        return;
    }
    for (size_t i = 0; i < out_len; i++) {
        unsigned int byte = 0;
        if (sscanf(hex + 2 * i, "%2x", &byte) != 1) {
            fprintf(stderr, "tk_hex: bad hex in \"%s\"\n", hex);
            tk_test_failures++;
            return;
        }
        out[i] = (uint8_t)byte;
    }
}

static inline int tk_test_result(void) {
    if (tk_test_failures == 0) {
        printf("OK\n");
        return 0;
    }
    fprintf(stderr, "%d check(s) failed\n", tk_test_failures);
    return 1;
}

#endif
