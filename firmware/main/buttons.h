// The six buttons: 5 ms scan, 30 ms debounce, long presses, and the I6 rule that a press starting
// during a clip never counts (core/include/tk_platform.h, wait_button).

#ifndef TK_FW_BUTTONS_H
#define TK_FW_BUTTONS_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_platform.h"

#define TK_BTN_SCAN_MS 5u
#define TK_BTN_DEBOUNCE_MS 30u   // docs/AUDIO.md
#define TK_BTN_LONG_MS 2000u     // long-press OK (repeat) and REJECT (cancel), docs/AUDIO.md

// Configures the pins and starts the scan timer. False on failure: then no press is ever reported.
bool tk_buttons_init(void);

// Waits up to timeout_ms for a press (TK_BTN_NONE on timeout).
tk_button_t tk_buttons_wait(uint32_t timeout_ms);

// play_clip brackets every clip with these. Nothing pressed before or during the clip is reported,
// and a button still held when the clip ends is ignored until it is released.
void tk_buttons_clip_start(void);
void tk_buttons_clip_end(void);

// True once after OK + BACK were held together for 3 s with no clip playing (the speaker-mode toggle);
// a clip starting or ending clears it. main.c calls it between requests only.
bool tk_buttons_take_chord(void);

bool tk_buttons_any_down(void); // debounced; for the bring-up LED

const char *tk_button_name(tk_button_t b); // bring-up only

#endif
