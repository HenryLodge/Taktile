// Health checks on hardware RNG output (SECURITY_MODEL I11).
//
// These catch a stuck, zeroed or grossly biased RNG. They can't prove output is random; that
// comes from the entropy source being on (I11). A failure means: refuse to hand out randomness.

#ifndef TK_RNG_HEALTH_H
#define TK_RNG_HEALTH_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Size of the sample the startup test expects.
#define TK_RNG_STARTUP_LEN 512u

// Startup test on exactly TK_RNG_STARTUP_LEN bytes. Fails (false) if two adjacent 32-bit words are
// equal, the count of 1-bits is outside 2048 +/- 192 (about 6 sigma), or any byte value appears
// more than 16 times (expected 2). Also false for a NULL buffer or the wrong length.
bool tk_rng_startup_ok(const uint8_t *buf, size_t len);

// Continuous test: each 32-bit output word must differ from the previous one. Once tripped it stays
// failed (latched). A good RNG trips it about once in 2^32 words.
typedef struct {
    uint32_t last;
    bool have_last;
    bool failed;
} tk_rng_cont_t;

void tk_rng_cont_init(tk_rng_cont_t *st);

// Feeds one word. Returns false if the test has failed (now or earlier).
bool tk_rng_cont_next(tk_rng_cont_t *st, uint32_t word);

#endif
