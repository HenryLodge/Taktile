// What firmware and sim/ provide to core. core/ never calls ESP-IDF or POSIX directly.
//
// Single-threaded model: core runs request flows inside tk_device_poll() and services the serial
// link itself between clips and between short wait_button() slices (docs/ARCHITECTURE.md).

#ifndef TK_PLATFORM_H
#define TK_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
    TK_BTN_NONE = 0, // wait_button timed out
    TK_BTN_UP,
    TK_BTN_DOWN,
    TK_BTN_OK,
    TK_BTN_BACK,
    TK_BTN_CONFIRM,
    TK_BTN_REJECT,
    TK_BTN_OK_LONG,     // long-press OK: repeat the last announcement
    TK_BTN_REJECT_LONG, // long-press REJECT (2 s): cancel the current flow
} tk_button_t;

typedef enum {
    TK_HAPTIC_TICK,    // button press registered
    TK_HAPTIC_SUCCESS, // signed
    TK_HAPTIC_REJECT,  // rejected or cancelled
    TK_HAPTIC_WARNING, // unknown recipient, wrong PIN, cannot sign
} tk_haptic_t;

typedef struct {
    void *ctx; // passed back to every call

    // Plays one clip (tk_clip_t) to the earpiece and returns when it has finished. secret marks
    // private audio (I2): checksum words and PIN digit values. A secret clip must never be logged
    // or printed (sim/ prints only "(private)" unless built with TK_SIM_INSECURE_AUDIO) and never
    // leaves the earpiece.
    void (*play_clip)(void *ctx, uint16_t clip, bool secret);
    void (*haptic)(void *ctx, tk_haptic_t pattern);

    // Waits up to timeout_ms for a press and returns it (TK_BTN_NONE on timeout; returning early
    // with TK_BTN_NONE is allowed). Presses that start while a clip is playing must be discarded
    // when the clip ends; they are never returned. This is what makes I6 hold: CONFIRM pressed
    // during the announcement is never seen. Presses between calls are kept.
    tk_button_t (*wait_button)(void *ctx, uint32_t timeout_ms);

    uint32_t (*now_ms)(void *ctx); // monotonic milliseconds; wraps
    bool (*random_bytes)(void *ctx, uint8_t *out, size_t len); // hardware RNG (I11)
    bool (*storage_get)(void *ctx, const char *key, void *buf, size_t *len);
    bool (*storage_set)(void *ctx, const char *key, const void *buf, size_t len);

    // Serial link (USB CDC or the sim's WebSocket). serial_read never blocks: it returns the
    // number of bytes copied, 0 if none are waiting.
    size_t (*serial_read)(void *ctx, uint8_t *buf, size_t cap);
    void (*serial_write)(void *ctx, const uint8_t *buf, size_t len);

    // True only if clips really play (audio output works and the clip pack is valid). Flows that
    // need the user to hear something refuse with DEVICE_ERROR otherwise (fail closed).
    bool (*audio_ok)(void *ctx);
} tk_platform_t;

#endif
