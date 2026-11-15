// Small pure helpers for the simulator: base58, hex, key decoding, clip text. Unit tested in
// sim/tests/test_ws.c.

#ifndef SIM_UTIL_H
#define SIM_UTIL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tk_platform.h"

// Base58 (Bitcoin/Solana alphabet) <-> exactly 32 bytes.
bool sim_base58_decode32(const char *s, uint8_t out[32]);
void sim_base58_encode32(const uint8_t in[32], char out[45]);

// 64 hex characters -> 32 bytes.
bool sim_hex32(const char *s, uint8_t out[32]);

// An address given on the command line: 64 hex characters or base58.
bool sim_parse_address(const char *s, uint8_t out[32]);

// Keyboard -> buttons. Keys: Up/Down arrows, Enter = OK, Backspace = BACK, c = CONFIRM,
// r = REJECT, O = long OK (repeat), R = long REJECT (cancel), q = quit (when idle).
typedef enum {
    SIM_KEY_NEED_MORE = 0, // an escape sequence has started
    SIM_KEY_BUTTON,
    SIM_KEY_QUIT,
    SIM_KEY_IGNORED,
} sim_key_kind_t;

// Decode one key from buf[0..len). Sets *used (>= 1 unless NEED_MORE) and, for SIM_KEY_BUTTON, *button.
sim_key_kind_t sim_decode_key(const uint8_t *buf, size_t len, size_t *used, tk_button_t *button);

// Text of a clip (tk_clip_t), as spoken. Never NULL.
const char *sim_clip_text(uint16_t clip);

#endif
