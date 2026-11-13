#include "tk_util.h"

bool tk_ct_equal(const uint8_t *a, const uint8_t *b, size_t len) {
    // volatile keeps the compiler from turning this into an early-exit loop.
    volatile uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0;
}
