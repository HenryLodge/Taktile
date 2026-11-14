// Turn amounts and names into clip sequences (tk_clip_t). Pure functions: nothing is played here.

#ifndef TK_SPEECH_H
#define TK_SPEECH_H

#include <stddef.h>
#include <stdint.h>

#include "tk_parser.h" // tk_tx_kind_t

// Longest amount: u64 max lamports or USDC units, read out in full.
#define TK_SPEECH_AMOUNT_MAX 64u

// An amount in base units, read as a decimal number of tokens: SOL has 9 decimals, USDC 6.
// The whole part is spoken in English ("one thousand two hundred five"); digits after the point
// are spoken one by one with trailing zeros dropped ("zero point zero zero one five").
// Returns the number of clips written, or 0 if kind is unknown or cap is too small.
size_t tk_speech_amount(tk_tx_kind_t kind, uint64_t amount, uint16_t *clips, size_t cap);

// Spell a contact name: letters (any case), digits, space, hyphen, apostrophe. Returns the number
// of clips written, or 0 on an unspellable character or too small a buffer.
size_t tk_speech_spell(const char *name, size_t len, uint16_t *clips, size_t cap);

#endif
