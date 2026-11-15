// "Rotary" PIN entry (docs/AUDIO.md). For each digit: a random start digit is spoken; UP/DOWN step
// it (wrapping 0-9) and speak the new value; OK commits; BACK returns to the previous digit.
// An observer sees only up/down counts, which reveal nothing without the private start digit.
//
// Digits are spoken only to the earpiece and never written anywhere else (I2). The caller wipes
// the returned PIN with memzero as soon as it has been used.

#ifndef TK_PIN_ENTRY_H
#define TK_PIN_ENTRY_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_platform.h"
#include "tk_wallet.h" // TK_PIN_LEN

#define TK_PIN_IDLE_TIMEOUT_MS 60000u

// The I/O a flow runs on. The device builds one over tk_platform_t that also services the serial
// link; its wait() returns TK_BTN_REJECT_LONG when the host has sent CANCEL.
typedef struct {
    void *ctx;
    void (*play)(void *ctx, uint16_t clip, bool secret); // see tk_platform_t.play_clip
    void (*haptic)(void *ctx, tk_haptic_t pattern);
    tk_button_t (*wait)(void *ctx, uint32_t timeout_ms); // TK_BTN_NONE only once timeout_ms passed
    bool (*random_bytes)(void *ctx, uint8_t *out, size_t len);
} tk_ui_t;

typedef enum {
    TK_PIN_OK = 0,
    TK_PIN_CANCELLED,  // long-press REJECT or host CANCEL
    TK_PIN_REJECTED,   // REJECT
    TK_PIN_TIMEOUT,    // no press for TK_PIN_IDLE_TIMEOUT_MS
    TK_PIN_RNG_FAILED, // random_bytes failed: fail closed
} tk_pin_result_t;

// On anything but TK_PIN_OK, pin is zeroed.
tk_pin_result_t tk_pin_entry(const tk_ui_t *ui, uint8_t pin[TK_PIN_LEN]);

#endif
