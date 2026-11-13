// Platform hooks that trezor-crypto expects the integrator to provide.
//
// We deliberately do not vendor trezor's rand.c. All randomness in Taktile
// comes from tk_platform_t.random_bytes (SECURITY_MODEL I11). The only
// vendored callers of random_buffer() are the unused ed25519 "cosi"
// functions; Ed25519 signing itself is deterministic. If anything ever does
// reach random_buffer(), crash rather than return weak or zero bytes.

#include <stdint.h>
#include <stdlib.h>

#include "fault_handler.h"
#include "rand.h"

void random_buffer(uint8_t *buf, size_t len) {
    (void)buf;
    (void)len;
    abort();
}

// Called by consteq() and friends when they detect a fault (e.g. glitching).
// Halting is the only safe response.
void tc_fault_handler(const char *msg) {
    (void)msg;
    abort();
}
