// Rotary PIN entry against a scripted tk_ui_t.

#include "tk_clips.h"
#include "tk_pin_entry.h"
#include "tk_test.h"

typedef struct {
    tk_button_t presses[128];
    size_t n, pos;
    uint8_t rng[32];
    size_t rng_n, rng_pos;
    bool rng_fail;
    uint16_t clips[512];
    bool secret[512];
    size_t clip_n;
    int ticks;
    uint32_t waited_timeout;
} script_t;

static script_t sc;

static void s_play(void *ctx, uint16_t clip, bool secret) {
    (void)ctx;
    if (sc.clip_n < 512) {
        sc.secret[sc.clip_n] = secret;
        sc.clips[sc.clip_n++] = clip;
    }
}

static void s_haptic(void *ctx, tk_haptic_t p) {
    (void)ctx;
    sc.ticks += p == TK_HAPTIC_TICK;
}

static tk_button_t s_wait(void *ctx, uint32_t timeout_ms) {
    (void)ctx;
    sc.waited_timeout = timeout_ms;
    return sc.pos < sc.n ? sc.presses[sc.pos++] : TK_BTN_NONE;
}

static bool s_random(void *ctx, uint8_t *out, size_t len) {
    (void)ctx;
    if (sc.rng_fail) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        out[i] = sc.rng_n ? sc.rng[sc.rng_pos++ % sc.rng_n] : 0;
    }
    return true;
}

static const tk_ui_t UI = {NULL, s_play, s_haptic, s_wait, s_random};

static void reset(void) {
    memset(&sc, 0, sizeof(sc));
}

static void press(tk_button_t b, int times) {
    for (int i = 0; i < times; i++) {
        sc.presses[sc.n++] = b;
    }
}

static void rng(const uint8_t *bytes, size_t n) {
    memcpy(sc.rng, bytes, n);
    sc.rng_n = n;
}

static void test_basic(void) {
    // Start digits from RNG: 7, 0, 5, 9, 2, 4 (bytes are taken mod 10).
    reset();
    static const uint8_t r[] = {17, 0, 245, 9, 12, 104};
    rng(r, sizeof(r));
    // Target 1 2 3 4 5 6: 7->1 is UP x4 (wraps); 0->2 UP x2; 5->3 DOWN x2; 9->4 DOWN x5; 2->5 UP x3; 4->6 UP x2.
    press(TK_BTN_UP, 4);
    press(TK_BTN_OK, 1);
    press(TK_BTN_UP, 2);
    press(TK_BTN_OK, 1);
    press(TK_BTN_DOWN, 2);
    press(TK_BTN_OK, 1);
    press(TK_BTN_DOWN, 5);
    press(TK_BTN_OK, 1);
    press(TK_BTN_UP, 3);
    press(TK_BTN_OK, 1);
    press(TK_BTN_UP, 2);
    press(TK_BTN_OK, 1);
    uint8_t pin[TK_PIN_LEN];
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_OK);
    static const uint8_t want[TK_PIN_LEN] = {1, 2, 3, 4, 5, 6};
    TK_CHECK_MEM(pin, want, TK_PIN_LEN);
    TK_CHECK(sc.ticks == (int)sc.n); // one tick per press
    TK_CHECK(sc.waited_timeout == TK_PIN_IDLE_TIMEOUT_MS);
    // First announcement: "digit one seven".
    TK_CHECK(sc.clips[0] == TK_CLIP_DIGIT && sc.clips[1] == TK_CLIP_ZERO + 1 && sc.clips[2] == TK_CLIP_ZERO + 7);
    // Then UP x4 speaks 8 9 0 1 (wrap).
    TK_CHECK(sc.clips[3] == TK_CLIP_ZERO + 8 && sc.clips[5] == TK_CLIP_ZERO + 0 && sc.clips[6] == TK_CLIP_ZERO + 1);
    // I2: every digit value is secret; only "digit" and the position number are public.
    for (size_t i = 0; i < sc.clip_n; i++) {
        const bool is_position = i > 0 && sc.clips[i - 1] == TK_CLIP_DIGIT;
        const bool want_secret = sc.clips[i] != TK_CLIP_DIGIT && !is_position;
        TK_CHECK(sc.secret[i] == want_secret);
    }
}

static void test_back(void) {
    reset(); // all start digits 0
    press(TK_BTN_UP, 3);
    press(TK_BTN_OK, 1); // digit 1 = 3
    press(TK_BTN_BACK, 1); // back to digit 1, new start digit 0
    press(TK_BTN_UP, 9);
    press(TK_BTN_OK, 1); // digit 1 = 9
    press(TK_BTN_DOWN, 1);
    press(TK_BTN_OK, 1); // digit 2 = 9
    press(TK_BTN_BACK, 1);
    press(TK_BTN_BACK, 1);
    press(TK_BTN_BACK, 1); // already at digit 1: stays
    press(TK_BTN_OK, 5);
    press(TK_BTN_OK_LONG, 1); // repeat: no effect on value
    press(TK_BTN_CONFIRM, 1); // ignored
    press(TK_BTN_OK, 1);
    uint8_t pin[TK_PIN_LEN];
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_OK);
    static const uint8_t want[TK_PIN_LEN] = {0, 0, 0, 0, 0, 0};
    TK_CHECK_MEM(pin, want, TK_PIN_LEN);
}

static void test_endings(void) {
    uint8_t pin[TK_PIN_LEN];
    reset();
    press(TK_BTN_UP, 1);
    press(TK_BTN_OK, 1);
    press(TK_BTN_REJECT_LONG, 1);
    memset(pin, 0x55, sizeof(pin));
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_CANCELLED);
    static const uint8_t zero[TK_PIN_LEN];
    TK_CHECK_MEM(pin, zero, TK_PIN_LEN); // the digit already entered is wiped

    reset();
    press(TK_BTN_OK, 2);
    press(TK_BTN_REJECT, 1);
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_REJECTED);
    TK_CHECK_MEM(pin, zero, TK_PIN_LEN);

    reset();
    press(TK_BTN_OK, 3); // then the script runs out: timeout
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_TIMEOUT);
    TK_CHECK_MEM(pin, zero, TK_PIN_LEN);

    reset();
    sc.rng_fail = true;
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_RNG_FAILED);
    TK_CHECK(sc.clip_n == 0);
}

static void test_rejection_sampling(void) {
    // Bytes 250-255 would bias 0-5; they must be drawn again.
    reset();
    static const uint8_t r[] = {250, 255, 251, 3};
    rng(r, sizeof(r));
    press(TK_BTN_OK, 1);
    press(TK_BTN_REJECT, 1);
    uint8_t pin[TK_PIN_LEN];
    tk_pin_entry(&UI, pin);
    TK_CHECK(sc.clips[2] == TK_CLIP_ZERO + 3); // start digit came from the byte 3
    TK_CHECK(sc.rng_pos >= 4);

    // An RNG stuck at 255 fails closed instead of looping forever.
    reset();
    static const uint8_t stuck[] = {255};
    rng(stuck, 1);
    TK_CHECK(tk_pin_entry(&UI, pin) == TK_PIN_RNG_FAILED);
}

int main(void) {
    test_basic();
    test_back();
    test_endings();
    test_rejection_sampling();
    return tk_test_result();
}
