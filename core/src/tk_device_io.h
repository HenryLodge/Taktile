// Internal to core/src: the flow I/O that tk_flow.c owns, shared with other on-device flows
// (tk_setup.c, tk_enroll.c). Not part of core's public API (not in include/).

#ifndef TK_DEVICE_IO_H
#define TK_DEVICE_IO_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_device.h"

// Play a clip through the flow I/O: services the serial link before and after, and plays nothing
// once the host has cancelled. secret = private audio (I2).
void tk_dev_play(tk_device_t *d, uint16_t clip, bool secret);
void tk_dev_say(tk_device_t *d, uint16_t clip); // public clip

void tk_dev_send_event(tk_device_t *d, tk_event_t event); // with the current flow's seq

// Load the wallet's public key and derive its USDC ATA once. False if there is no usable wallet.
bool tk_dev_ensure_keys(tk_device_t *d);

// The platform reports working audio (clip pack valid, I2S up). Flows refuse without it (Q7).
bool tk_dev_audio_ok(const tk_device_t *d);

// Reject pulse and "cancelled" (heard even after a host CANCEL); returns CANCELLED.
tk_status_t tk_dev_finish_cancelled(tk_device_t *d);

// PIN entry until the wallet is unlocked (I7): "please wait" during each check, wrong PINs counted,
// the lockout wipe (contacts too). Returns OK, or the status to reply with (the ending is played).
// pin is scratch space for the digits and is wiped before returning.
tk_status_t tk_dev_unlock(tk_device_t *d, uint8_t pin[TK_PIN_LEN]);

// The confirm window (I6): EVENT AWAITING_CONFIRM, the prompt, then 30 s for CONFIRM. Hold OK calls
// repeat(d, ctx) (the flow's announcement), says the prompt again and restarts the 30 s. Returns OK
// on CONFIRM; otherwise REJECTED_BY_USER (REJECT, timeout) or CANCELLED (long REJECT, host CANCEL),
// with the ending played.
typedef void (*tk_dev_announce_fn)(tk_device_t *d, void *ctx);
tk_status_t tk_dev_confirm_window(tk_device_t *d, uint16_t prompt, tk_dev_announce_fn repeat, void *ctx);

#endif
