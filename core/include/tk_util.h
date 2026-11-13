#ifndef TK_UTIL_H
#define TK_UTIL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Constant-time equality: runtime depends only on len, never on the contents.
// Use for comparing keys, addresses, and anything derived from secrets.
bool tk_ct_equal(const uint8_t *a, const uint8_t *b, size_t len);

#endif
