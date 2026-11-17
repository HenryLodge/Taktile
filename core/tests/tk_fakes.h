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
    int value;   // clip id, haptic, button, unlock result, sign ok
    bool secret; // OP_CLIP: played as secret audio
} op_t;

#define FAKE_MAX_OPS 4096
static op_t fake_ops[FAKE_MAX_OPS];
static size_t fake_op_count;

static inline void fake_log(op_kind_t kind, int value) {
    if (fake_op_count < FAKE_MAX_OPS) {
        fake_ops[fake_op_count].kind = kind;
        fake_ops[fake_op_count].value = value;
        fake_ops[fake_op_count].secret = false;
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
    uint8_t stored[1024]; // mirror of the "contacts" key, for the flow tests
    size_t stored_len;
    bool stored_set;

    // Storage: a small key table. set_log records every storage_set key in call order (also the
    // failed ones). fail_set_key makes storage_set of that key fail; storage_off fails everything.
    struct {
        bool used;
        char key[16];
        uint8_t val[1024];
        size_t len;
    } kv[8];
    char set_log[32][16];
    size_t set_count;
    const char *fail_set_key;
    const char *flip_get_key; // storage_get of this key returns its first byte flipped
    bool storage_off;

    bool audio_bad;    // audio_ok() returns false
    bool speaker_mode; // private_audio_only() returns false
} fake_platform_t;

static fake_platform_t fake;

static inline void fake_reset(void) {
    memset(&fake, 0, sizeof(fake));
    fake.now = 1000;
    fake_op_count = 0;
}

static inline void fake_rx_push(const uint8_t *b, size_t n) {
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

static inline void fake_press(tk_button_t b) {
    fake_add_step(STEP_PRESS)->button = b;
}

static inline void fake_press_during_clip(tk_button_t b) {
    fake_add_step(STEP_PRESS_DURING_CLIP)->button = b;
}

static inline void fake_advance(uint32_t ms) {
    fake_add_step(STEP_ADVANCE)->ms = ms;
}

// Encode a host frame into a script step.
static inline void fake_frame(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len) {
    step_t *s = fake_add_step(STEP_FRAME);
    tk_frame_encode(type, seq, payload, len, s->frame, sizeof(s->frame), &s->frame_len);
}

static inline void fake_raw_frame(const uint8_t *bytes, size_t len) {
    step_t *s = fake_add_step(STEP_FRAME);
    memcpy(s->frame, bytes, len);
    s->frame_len = len;
}

// The request that starts a test: queued on the link before the first poll.
static inline void fake_send_now(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len) {
    static uint8_t buf[TK_FRAME_MAX_LEN];
    size_t n = 0;
    tk_frame_encode(type, seq, payload, len, buf, sizeof(buf), &n);
    fake_rx_push(buf, n);
}

static inline void fp_play_clip(void *ctx, uint16_t clip, bool secret) {
    (void)ctx;
    fake_log(OP_CLIP, clip);
    if (fake_op_count > 0) {
        fake_ops[fake_op_count - 1].secret = secret;
    }
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

static inline void fp_haptic(void *ctx, tk_haptic_t p) {
    (void)ctx;
    fake_log(OP_HAPTIC, (int)p);
}

static inline tk_button_t fp_wait_button(void *ctx, uint32_t timeout_ms) {
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

static inline uint32_t fp_now(void *ctx) {
    (void)ctx;
    return fake.now;
}

static inline bool fp_random(void *ctx, uint8_t *out, size_t len) {
    (void)ctx;
    if (fake.rng_fail) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        out[i] = fake.rng_len ? fake.rng[fake.rng_pos++ % fake.rng_len] : 0;
    }
    return true;
}

static inline int fake_kv_find(const char *key) {
    for (int i = 0; i < 8; i++) {
        if (fake.kv[i].used && strcmp(fake.kv[i].key, key) == 0) {
            return i;
        }
    }
    return -1;
}

// Test helper: store a value directly, bypassing set_log and failure injection.
static inline void fake_kv_put(const char *key, const void *buf, size_t len) {
    int i = fake_kv_find(key);
    for (int j = 0; i < 0 && j < 8; j++) {
        if (!fake.kv[j].used) {
            i = j;
        }
    }
    if (i < 0 || strlen(key) >= sizeof(fake.kv[i].key) || len > sizeof(fake.kv[i].val)) {
        return;
    }
    fake.kv[i].used = true;
    strcpy(fake.kv[i].key, key);
    if (len > 0) {
        memcpy(fake.kv[i].val, buf, len);
    }
    fake.kv[i].len = len;
}

static inline bool fp_storage_get(void *ctx, const char *key, void *buf, size_t *len) {
    (void)ctx;
    const int i = fake.storage_off ? -1 : fake_kv_find(key);
    if (i < 0 || fake.kv[i].len > *len) {
        return false;
    }
    if (fake.kv[i].len > 0) {
        memcpy(buf, fake.kv[i].val, fake.kv[i].len);
        if (fake.flip_get_key != NULL && strcmp(key, fake.flip_get_key) == 0) {
            ((uint8_t *)buf)[0] ^= 1;
        }
    }
    *len = fake.kv[i].len;
    return true;
}

static inline bool fp_storage_set(void *ctx, const char *key, const void *buf, size_t len) {
    (void)ctx;
    if (fake.set_count < 32 && strlen(key) < 16) {
        strcpy(fake.set_log[fake.set_count++], key);
    }
    if (fake.storage_off || (fake.fail_set_key != NULL && strcmp(key, fake.fail_set_key) == 0) ||
        len > sizeof(fake.stored)) {
        return false;
    }
    fake_kv_put(key, buf, len);
    if (strcmp(key, "contacts") == 0) {
        if (len > 0) {
            memcpy(fake.stored, buf, len);
        }
        fake.stored_len = len;
        fake.stored_set = true;
    }
    return true;
}

static inline size_t fp_serial_read(void *ctx, uint8_t *buf, size_t cap) {
    (void)ctx;
    size_t n = fake.rx_len - fake.rx_pos;
    if (n > cap) {
        n = cap;
    }
    memcpy(buf, fake.rx + fake.rx_pos, n);
    fake.rx_pos += n;
    return n;
}

static inline void fp_serial_write(void *ctx, const uint8_t *buf, size_t len) {
    (void)ctx;
    fake_log(OP_WRITE, buf[2]); // frame type
    if (fake.tx_len + len <= FAKE_TX_CAP) {
        memcpy(fake.tx + fake.tx_len, buf, len);
        fake.tx_len += len;
    }
}

static inline bool fp_audio_ok(void *ctx) {
    (void)ctx;
    return !fake.audio_bad;
}

static inline bool fp_private_audio_only(void *ctx) {
    (void)ctx;
    return !fake.speaker_mode;
}

static const tk_platform_t FAKE_PLATFORM = {
    NULL, fp_play_clip, fp_haptic, fp_wait_button, fp_now, fp_random,
    fp_storage_get, fp_storage_set, fp_serial_read, fp_serial_write,
    fp_audio_ok, fp_private_audio_only,
};

// ---- Decoding what the device wrote ----

typedef struct {
    uint8_t type, seq;
    uint8_t payload[80];
    uint16_t len;
} out_frame_t;

static inline size_t fake_output(out_frame_t *out, size_t cap) {
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
    int sign_calls, unlock_calls, create_calls;
    bool signed_while_locked;
    bool unlock_error; // unlock returns TK_UNLOCK_ERROR
    bool fail_create;  // create returns false
    uint8_t created_pin[TK_PIN_LEN];
} fake_wallet_t;

static fake_wallet_t fw;

static inline void fake_wallet_reset(bool has_wallet, bool unlocked) {
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

static inline bool fwl_has(void *ctx) {
    (void)ctx;
    return fw.has_wallet;
}

static inline bool fwl_pubkey(void *ctx, uint8_t out[32]) {
    (void)ctx;
    if (!fw.has_wallet) {
        return false;
    }
    memcpy(out, fw.pk, 32);
    return true;
}

static inline bool fwl_unlocked(void *ctx) {
    (void)ctx;
    return fw.has_wallet && fw.unlocked;
}

static inline tk_unlock_result_t fwl_unlock(void *ctx, const uint8_t pin[TK_PIN_LEN], uint8_t *left) {
    (void)ctx;
    fw.unlock_calls++;
    if (fw.unlock_error) {
        fake_log(OP_UNLOCK, TK_UNLOCK_ERROR);
        return TK_UNLOCK_ERROR;
    }
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

static inline bool fwl_sign(void *ctx, const uint8_t *msg, size_t len, uint8_t sig[TK_SIGNATURE_LEN]) {
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

static inline bool fwl_create(void *ctx, const uint8_t pin[TK_PIN_LEN], const uint8_t sk[32], const uint8_t pubkey[32]) {
    (void)ctx;
    fw.create_calls++;
    if (fw.has_wallet || fw.fail_create) {
        return false;
    }
    memcpy(fw.sk, sk, 32);
    memcpy(fw.pk, pubkey, 32);
    memcpy(fw.pin, pin, TK_PIN_LEN);
    memcpy(fw.created_pin, pin, TK_PIN_LEN);
    fw.has_wallet = true;
    fw.unlocked = true;
    return true;
}

static const tk_wallet_ops_t FAKE_WALLET = {NULL, fwl_has, fwl_pubkey, fwl_unlocked, fwl_unlock, fwl_sign, fwl_create};

#endif
