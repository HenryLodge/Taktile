// Fake platform and fake wallet for the flow tests.
//
// The fake platform plays a script. Script steps are consumed by wait_button() and play_clip():
//   STEP_PRESS             wait_button returns this button
//   STEP_PRESS_DURING_CLIP a press that starts during a clip: the clip discards it (I6 contract)
//   STEP_FRAME             bytes arrive on the serial link (consumed by whichever call is next)
//   STEP_ADVANCE           time passes (ms)
// When the script runs out, wait_button lets its whole timeout pass. Every call is logged.
//
// The fake wallet uses a real Ed25519 key from the public test seed sha256("taktile-vector:device"),
// the same "device" the parser vectors use, so signatures verify against the vectors' device key.

#ifndef TK_FAKES_H
#define TK_FAKES_H

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "ed25519.h"
#include "sha2.h"
#include "tk_clips.h"
#include "tk_platform.h"
#include "tk_proto.h"
#include "tk_wallet.h"

// ---- Operation log (shared by both fakes, in call order) ----

typedef enum { OP_CLIP, OP_HAPTIC, OP_BUTTON, OP_WRITE, OP_UNLOCK, OP_SIGN } op_kind_t;

typedef struct {
    op_kind_t kind;
    int value; // clip id, haptic, button, unlock result, sign ok
} op_t;

#define FAKE_MAX_OPS 4096
static op_t fake_ops[FAKE_MAX_OPS];
static size_t fake_op_count;

static void fake_log(op_kind_t kind, int value) {
    if (fake_op_count < FAKE_MAX_OPS) {
        fake_ops[fake_op_count].kind = kind;
        fake_ops[fake_op_count].value = value;
        fake_op_count++;
    }
}

// ---- Fake platform ----

typedef enum { STEP_PRESS, STEP_PRESS_DURING_CLIP, STEP_FRAME, STEP_ADVANCE } step_kind_t;

typedef struct {
    step_kind_t kind;
    tk_button_t button;
    uint32_t ms;
    uint8_t frame[96];
    size_t frame_len;
} step_t;

#define FAKE_MAX_STEPS 256
#define FAKE_RX_CAP 8192
#define FAKE_TX_CAP 16384

typedef struct {
    step_t steps[FAKE_MAX_STEPS];
    size_t step_count, cursor;
    uint32_t now;
    uint8_t rx[FAKE_RX_CAP];
    size_t rx_len, rx_pos;
    uint8_t tx[FAKE_TX_CAP];
    size_t tx_len;
    uint8_t rng[64];
    size_t rng_len, rng_pos; // rng[] repeats; empty means always 0
    bool rng_fail;
    size_t discarded_presses;
    uint8_t stored[1024];
    size_t stored_len;
    bool stored_set;
} fake_platform_t;

static fake_platform_t fake;

static void fake_reset(void) {
    memset(&fake, 0, sizeof(fake));
    fake.now = 1000;
    fake_op_count = 0;
}

static void fake_rx_push(const uint8_t *b, size_t n) {
    if (fake.rx_len + n <= FAKE_RX_CAP) {
        memcpy(fake.rx + fake.rx_len, b, n);
        fake.rx_len += n;
    }
}

static step_t *fake_add_step(step_kind_t kind) {
    step_t *s = &fake.steps[fake.step_count++];
    memset(s, 0, sizeof(*s));
    s->kind = kind;
    return s;
}

static void fake_press(tk_button_t b) {
    fake_add_step(STEP_PRESS)->button = b;
}

static void fake_press_during_clip(tk_button_t b) {
    fake_add_step(STEP_PRESS_DURING_CLIP)->button = b;
}

static void fake_advance(uint32_t ms) {
    fake_add_step(STEP_ADVANCE)->ms = ms;
}

// Encode a host frame into a script step.
static void fake_frame(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len) {
    step_t *s = fake_add_step(STEP_FRAME);
    tk_frame_encode(type, seq, payload, len, s->frame, sizeof(s->frame), &s->frame_len);
}

static void fake_raw_frame(const uint8_t *bytes, size_t len) {
    step_t *s = fake_add_step(STEP_FRAME);
    memcpy(s->frame, bytes, len);
    s->frame_len = len;
}

// The request that starts a test: queued on the link before the first poll.
static void fake_send_now(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len) {
    static uint8_t buf[TK_FRAME_MAX_LEN];
    size_t n = 0;
    tk_frame_encode(type, seq, payload, len, buf, sizeof(buf), &n);
    fake_rx_push(buf, n);
}

static void fp_play_clip(void *ctx, uint16_t clip) {
    (void)ctx;
    fake_log(OP_CLIP, clip);
    fake.now += 400;
    // Frames that arrive during the clip are received; presses that start during it are dropped.
    while (fake.cursor < fake.step_count) {
        step_t *s = &fake.steps[fake.cursor];
        if (s->kind == STEP_PRESS_DURING_CLIP) {
            fake.discarded_presses++;
        } else if (s->kind == STEP_FRAME) {
            fake_rx_push(s->frame, s->frame_len);
        } else {
            break;
        }
        fake.cursor++;
    }
}

static void fp_haptic(void *ctx, tk_haptic_t p) {
    (void)ctx;
    fake_log(OP_HAPTIC, (int)p);
}

static tk_button_t fp_wait_button(void *ctx, uint32_t timeout_ms) {
    (void)ctx;
    if (fake.cursor >= fake.step_count) {
        fake.now += timeout_ms;
        return TK_BTN_NONE;
    }
    step_t *s = &fake.steps[fake.cursor++];
    switch (s->kind) {
    case STEP_PRESS:
        fake.now += 1;
        fake_log(OP_BUTTON, (int)s->button);
        return s->button;
    case STEP_FRAME:
        fake_rx_push(s->frame, s->frame_len);
        fake.now += 1;
        return TK_BTN_NONE;
    case STEP_ADVANCE:
        fake.now += s->ms;
        return TK_BTN_NONE;
    case STEP_PRESS_DURING_CLIP:
    default:
        fake.discarded_presses++; // no clip was playing: still never delivered
        return TK_BTN_NONE;
    }
}

static uint32_t fp_now(void *ctx) {
    (void)ctx;
    return fake.now;
}

static bool fp_random(void *ctx, uint8_t *out, size_t len) {
    (void)ctx;
    if (fake.rng_fail) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        out[i] = fake.rng_len ? fake.rng[fake.rng_pos++ % fake.rng_len] : 0;
    }
    return true;
}

static bool fp_storage_get(void *ctx, const char *key, void *buf, size_t *len) {
    (void)ctx;
    (void)key;
    (void)buf;
    (void)len;
    return false;
}

static bool fp_storage_set(void *ctx, const char *key, const void *buf, size_t len) {
    (void)ctx;
    if (strcmp(key, "contacts") != 0 || len > sizeof(fake.stored)) {
        return false;
    }
    memcpy(fake.stored, buf, len);
    fake.stored_len = len;
    fake.stored_set = true;
    return true;
}

static size_t fp_serial_read(void *ctx, uint8_t *buf, size_t cap) {
    (void)ctx;
    size_t n = fake.rx_len - fake.rx_pos;
    if (n > cap) {
        n = cap;
    }
    memcpy(buf, fake.rx + fake.rx_pos, n);
    fake.rx_pos += n;
    return n;
}

static void fp_serial_write(void *ctx, const uint8_t *buf, size_t len) {
    (void)ctx;
    fake_log(OP_WRITE, buf[2]); // frame type
    if (fake.tx_len + len <= FAKE_TX_CAP) {
        memcpy(fake.tx + fake.tx_len, buf, len);
        fake.tx_len += len;
    }
}

static const tk_platform_t FAKE_PLATFORM = {
    NULL, fp_play_clip, fp_haptic, fp_wait_button, fp_now, fp_random,
    fp_storage_get, fp_storage_set, fp_serial_read, fp_serial_write,
};

// ---- Decoding what the device wrote ----

typedef struct {
    uint8_t type, seq;
    uint8_t payload[80];
    uint16_t len;
} out_frame_t;

static size_t fake_output(out_frame_t *out, size_t cap) {
    static tk_frame_decoder_t dec;
    tk_frame_decoder_init(&dec);
    size_t pos = 0, n = 0;
    for (;;) {
        size_t used = 0;
        tk_frame_t f;
        const tk_frame_result_t r = tk_frame_decoder_feed(&dec, fake.tx + pos, fake.tx_len - pos, &used, &f);
        pos += used;
        if (r == TK_FRAME_NEED_MORE) {
            return n;
        }
        if (r == TK_FRAME_OK && n < cap) {
            out[n].type = f.type;
            out[n].seq = f.seq;
            out[n].len = f.len;
            memcpy(out[n].payload, f.payload, f.len < sizeof(out[n].payload) ? f.len : sizeof(out[n].payload));
            n++;
        }
    }
}

// ---- Fake wallet ----

typedef struct {
    bool has_wallet;
    bool unlocked;
    uint8_t pin[TK_PIN_LEN];
    int attempts_left; // lock out when it reaches 0
    ed25519_secret_key sk;
    ed25519_public_key pk;
    int sign_calls, unlock_calls;
    bool signed_while_locked;
} fake_wallet_t;

static fake_wallet_t fw;

static void fake_wallet_reset(bool has_wallet, bool unlocked) {
    memset(&fw, 0, sizeof(fw));
    fw.has_wallet = has_wallet;
    fw.unlocked = unlocked;
    static const uint8_t pin[TK_PIN_LEN] = {1, 2, 3, 4, 5, 6};
    memcpy(fw.pin, pin, sizeof(pin));
    fw.attempts_left = 10;
    const char *label = "taktile-vector:device";
    sha256_Raw((const uint8_t *)label, strlen(label), fw.sk);
    ed25519_publickey(fw.sk, fw.pk);
}

static bool fwl_has(void *ctx) {
    (void)ctx;
    return fw.has_wallet;
}

static bool fwl_pubkey(void *ctx, uint8_t out[32]) {
    (void)ctx;
    if (!fw.has_wallet) {
        return false;
    }
    memcpy(out, fw.pk, 32);
    return true;
}

static bool fwl_unlocked(void *ctx) {
    (void)ctx;
    return fw.has_wallet && fw.unlocked;
}

static tk_unlock_result_t fwl_unlock(void *ctx, const uint8_t pin[TK_PIN_LEN], uint8_t *left) {
    (void)ctx;
    fw.unlock_calls++;
    if (memcmp(pin, fw.pin, TK_PIN_LEN) == 0) {
        fw.unlocked = true;
        fw.attempts_left = 10;
        fake_log(OP_UNLOCK, TK_UNLOCK_OK);
        return TK_UNLOCK_OK;
    }
    if (--fw.attempts_left <= 0) {
        fw.has_wallet = false;
        fw.unlocked = false;
        fake_log(OP_UNLOCK, TK_UNLOCK_LOCKED_OUT);
        return TK_UNLOCK_LOCKED_OUT;
    }
    *left = (uint8_t)fw.attempts_left;
    fake_log(OP_UNLOCK, TK_UNLOCK_WRONG);
    return TK_UNLOCK_WRONG;
}

static bool fwl_sign(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[TK_SIGNATURE_LEN]) {
    (void)ctx;
    fw.sign_calls++;
    if (!fw.has_wallet || !fw.unlocked) {
        fw.signed_while_locked = true;
        fake_log(OP_SIGN, 0);
        return false;
    }
    ed25519_sign(msg, len, fw.sk, sig);
    fake_log(OP_SIGN, 1);
    return true;
}

static const tk_wallet_ops_t FAKE_WALLET = {NULL, fwl_has, fwl_pubkey, fwl_unlocked, fwl_unlock, fwl_sign};

#endif
