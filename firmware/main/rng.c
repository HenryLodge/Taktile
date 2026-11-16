// Hardware RNG with the entropy source on and fail-closed health checks (SECURITY_MODEL I11).
//
// With radios off, esp_random() is only truly random once bootloader_random_enable() has turned on
// the internal entropy source (on the S3 it runs through the SAR ADC: never use the ADC elsewhere).
// It is never disabled. Health checks (core/src/tk_rng_health.c) catch a stuck or broken RNG; any
// failure means no randomness until reboot, so seed generation and PIN entry fail closed.

#include "rng.h"

#include <string.h>

#include "bootloader_random.h"
#include "esp_random.h"

#include "tk_rng_health.h"

static bool entropy_on;
static bool startup_ok;
static tk_rng_cont_t cont;

void tk_rng_start(void) {
    bootloader_random_enable(); // I11: first, before anything draws randomness; never disabled
    entropy_on = true;

    uint8_t sample[TK_RNG_STARTUP_LEN];
    esp_fill_random(sample, sizeof(sample));
    startup_ok = tk_rng_startup_ok(sample, sizeof(sample));
    memset(sample, 0, sizeof(sample)); // discarded, never used as key material

    tk_rng_cont_init(&cont);
}

bool tk_rng_fill(uint8_t *out, size_t len) {
    if (out == NULL) {
        return false;
    }
    if (!entropy_on || !startup_ok || cont.failed) {
        memset(out, 0, len);
        return false;
    }
    for (size_t i = 0; i < len; i += 4) {
        const uint32_t w = esp_random();
        if (!tk_rng_cont_next(&cont, w)) {
            memset(out, 0, len);
            return false;
        }
        const size_t n = len - i < 4 ? len - i : 4;
        for (size_t j = 0; j < n; j++) {
            out[i + j] = (uint8_t)(w >> (8 * j));
        }
    }
    return true;
}

tk_rng_status_t tk_rng_status(void) {
    return (tk_rng_status_t){.entropy_on = entropy_on, .startup_ok = startup_ok, .cont_failed = cont.failed};
}
