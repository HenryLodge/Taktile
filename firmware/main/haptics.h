// Haptics: DRV2605L over I2C (SDA GPIO47, SCL GPIO48), ERM disc motor, built-in effect library.
// The four patterns are defined by docs/AUDIO.md ("Haptic patterns").

#ifndef TK_FW_HAPTICS_H
#define TK_FW_HAPTICS_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_platform.h"

#define TK_HAPTICS_ADDR 0x5A

// Starts the I2C bus and sets the DRV2605L up for an ERM motor. False if the bus or the chip
// failed; then every tk_haptics_play is a no-op (haptics are feedback only: everything is spoken).
bool tk_haptics_init(void);

// Starts a pattern and returns at once; the chip plays it on its own. A new pattern replaces one
// still playing. Never blocks longer than one short I2C timeout.
void tk_haptics_play(tk_haptic_t pattern);

typedef struct {
    bool bus_ok;
    bool chip_found;  // answered at TK_HAPTICS_ADDR
    uint8_t chip_id;  // STATUS bits 7:5: 7 = DRV2605L, 3 = DRV2605
    bool ready;       // init finished; patterns will play
} tk_haptics_status_t;

tk_haptics_status_t tk_haptics_status(void);

// Bring-up only.
const char *tk_haptics_name(tk_haptic_t pattern);
bool tk_haptics_probe(uint8_t addr); // does anything answer at addr on the same bus?

#endif
