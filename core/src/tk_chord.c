// See tk_chord.h.

#include "tk_chord.h"

void tk_chord_reset(tk_chord_t *c) {
    c->held_ms = 0;
    c->fired = false;
}

bool tk_chord_step(tk_chord_t *c, bool both_held, uint32_t dt_ms) {
    if (!both_held) {
        tk_chord_reset(c);
        return false;
    }
    if (c->fired) {
        return false;
    }
    const uint32_t left = TK_CHORD_MS - c->held_ms; // held_ms < TK_CHORD_MS while not fired
    c->held_ms = dt_ms >= left ? TK_CHORD_MS : c->held_ms + dt_ms;
    if (c->held_ms >= TK_CHORD_MS) {
        c->fired = true;
        return true;
    }
    return false;
}
