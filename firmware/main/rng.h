// Hardware RNG (SECURITY_MODEL I11). All randomness on the device comes through tk_rng_fill.

#ifndef TK_FW_RNG_H
#define TK_FW_RNG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// First call in app_main. Turns the internal entropy source on (bootloader_random_enable, never
// disabled), then runs the startup health test. Randomness is available only if that test passed.
void tk_rng_start(void);

// Fills out with hardware random bytes. Returns false (and zeroes out) if the entropy source was
// never started, the startup test failed, or the continuous test has ever tripped: fail closed.
bool tk_rng_fill(uint8_t *out, size_t len);

typedef struct {
    bool entropy_on;  // tk_rng_start ran (bootloader_random_enable called)
    bool startup_ok;  // startup health test passed
    bool cont_failed; // continuous test tripped since boot (latched)
} tk_rng_status_t;

tk_rng_status_t tk_rng_status(void); // for the bring-up menu only

#endif
