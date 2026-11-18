// Two-button hold ("chord") detector: the speaker-mode toggle, hold OK + BACK for 3 s (docs/AUDIO.md).
// Pure timing, no platform calls: the firmware's button scan feeds it every scan.

#ifndef TK_CHORD_H
#define TK_CHORD_H

#include <stdbool.h>
#include <stdint.h>

#define TK_CHORD_MS 3000u

typedef struct {
    uint32_t held_ms; // time both buttons have been held together (saturates at TK_CHORD_MS)
    bool fired;       // already reported for this hold
} tk_chord_t;

void tk_chord_reset(tk_chord_t *c);

// both_held: both buttons down now (and neither to be ignored). Returns true exactly once per hold,
// on the step where the hold reaches TK_CHORD_MS. Letting go of either button re-arms it.
bool tk_chord_step(tk_chord_t *c, bool both_held, uint32_t dt_ms);

#endif
