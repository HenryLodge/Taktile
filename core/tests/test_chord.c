// The speaker-mode chord detector (hold OK + BACK for 3 s).

#include "tk_chord.h"
#include "tk_test.h"

// Hold for n steps of dt ms; returns how many times it fired.
static int hold(tk_chord_t *c, uint32_t n, uint32_t dt) {
    int fired = 0;
    for (uint32_t i = 0; i < n; i++) {
        fired += tk_chord_step(c, true, dt);
    }
    return fired;
}

static void test_fires_at_3000_once(void) {
    tk_chord_t c;
    tk_chord_reset(&c);
    TK_CHECK(hold(&c, 599, 5) == 0); // 2995 ms
    TK_CHECK(tk_chord_step(&c, true, 5)); // 3000 ms
    TK_CHECK(hold(&c, 10000, 5) == 0); // still held: once per hold
}

static void test_release_rearms(void) {
    tk_chord_t c;
    tk_chord_reset(&c);
    TK_CHECK(hold(&c, 600, 5) == 1);
    TK_CHECK(!tk_chord_step(&c, false, 5));
    TK_CHECK(hold(&c, 599, 5) == 0);
    TK_CHECK(hold(&c, 1, 5) == 1);
}

static void test_early_release_restarts(void) {
    tk_chord_t c;
    tk_chord_reset(&c);
    TK_CHECK(hold(&c, 580, 5) == 0); // 2.9 s
    TK_CHECK(!tk_chord_step(&c, false, 5));
    TK_CHECK(hold(&c, 580, 5) == 0); // another 2.9 s: the count started over
    TK_CHECK(hold(&c, 20, 5) == 1);
}

static void test_reset_mid_hold(void) {
    tk_chord_t c;
    tk_chord_reset(&c);
    TK_CHECK(hold(&c, 500, 5) == 0);
    tk_chord_reset(&c); // a clip edge
    TK_CHECK(hold(&c, 599, 5) == 0);
    TK_CHECK(hold(&c, 1, 5) == 1);
}

static void test_never_without_both(void) {
    tk_chord_t c;
    tk_chord_reset(&c);
    for (int i = 0; i < 100000; i++) {
        TK_CHECK(!tk_chord_step(&c, false, 5));
    }
    TK_CHECK(c.held_ms == 0 && !c.fired);
}

static void test_big_steps_saturate(void) {
    tk_chord_t c;
    tk_chord_reset(&c);
    TK_CHECK(tk_chord_step(&c, true, UINT32_MAX)); // no overflow
    TK_CHECK(c.held_ms == TK_CHORD_MS);
    TK_CHECK(!tk_chord_step(&c, true, UINT32_MAX));
    tk_chord_reset(&c);
    TK_CHECK(!tk_chord_step(&c, true, 2999));
    TK_CHECK(tk_chord_step(&c, true, UINT32_MAX));
    tk_chord_reset(&c);
    TK_CHECK(!tk_chord_step(&c, true, 0));
    TK_CHECK(c.held_ms == 0);
}

int main(void) {
    test_fires_at_3000_once();
    test_release_rearms();
    test_early_release_restarts();
    test_reset_mid_hold();
    test_never_without_both();
    test_big_steps_saturate();
    return tk_test_result();
}
