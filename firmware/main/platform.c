// tk_platform_t on the Metro ESP32-S3.
//
// All real: serial link (USB-Serial-JTAG), the clock, buttons (buttons.c), audio (audio.c),
// haptics (haptics.c), the hardware RNG (rng.c: entropy source on, fail-closed health checks, I11)
// and storage (storage.c: plain NVS, fails closed, never auto-erased).
// The wallet is core's key store (core/src/tk_keystore.c), set up in main.c.

#include "platform.h"

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "audio.h"
#include "buttons.h"
#include "haptics.h"
#include "link.h"
#include "rng.h"
#include "storage.h"

static void p_play_clip(void *ctx, uint16_t clip, bool secret) {
    (void)ctx;
    tk_audio_play(clip, secret); // never log clip ids here: secret ones are private (I2)
}

static void p_haptic(void *ctx, tk_haptic_t pattern) {
    (void)ctx;
    tk_haptics_play(pattern); // returns at once; the chip plays it
}

static tk_button_t p_wait_button(void *ctx, uint32_t timeout_ms) {
    (void)ctx;
    return tk_buttons_wait(timeout_ms); // presses from before or during a clip are never returned
}

static uint32_t p_now_ms(void *ctx) {
    (void)ctx;
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static bool p_random_bytes(void *ctx, uint8_t *out, size_t len) {
    (void)ctx;
    return tk_rng_fill(out, len);
}

static bool p_storage_get(void *ctx, const char *key, void *buf, size_t *len) {
    (void)ctx;
    return tk_storage_get(key, buf, len);
}

static bool p_storage_set(void *ctx, const char *key, const void *buf, size_t len) {
    (void)ctx;
    return tk_storage_set(key, buf, len); // committed before it returns true
}

static size_t p_serial_read(void *ctx, uint8_t *buf, size_t cap) {
    (void)ctx;
    return tk_link_read(buf, cap);
}

static void p_serial_write(void *ctx, const uint8_t *buf, size_t len) {
    (void)ctx;
    tk_link_write(buf, len);
}

static bool p_audio_ok(void *ctx) {
    (void)ctx;
    const tk_audio_status_t st = tk_audio_status();
    return st.i2s_ok && st.pack == TK_CLIPPACK_OK; // else every clip would be silent
}

const tk_platform_t TK_FW_PLATFORM = {
    .ctx = NULL,
    .play_clip = p_play_clip,
    .haptic = p_haptic,
    .wait_button = p_wait_button,
    .now_ms = p_now_ms,
    .random_bytes = p_random_bytes,
    .storage_get = p_storage_get,
    .storage_set = p_storage_set,
    .serial_read = p_serial_read,
    .serial_write = p_serial_write,
    .audio_ok = p_audio_ok,
};
