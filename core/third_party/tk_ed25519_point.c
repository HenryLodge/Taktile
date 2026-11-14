#include "tk_ed25519_point.h"

#include "ed25519-donna.h"

bool tk_ed25519_on_curve(const uint8_t p[32]) {
    // Decompression succeeds exactly when (y^2 - 1) / (d*y^2 + 1) has a square root, which is the
    // on-curve test. The result is the negated point; only success matters here.
    ge25519 point;
    return ge25519_unpack_negative_vartime(&point, p) != 0;
}
