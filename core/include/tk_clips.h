// Audio clip IDs. Core owns this list; firmware, sim/ and tools/clips.json follow it (the clips
// task checks clips.json against this header). See docs/AUDIO.md.

#ifndef TK_CLIPS_H
#define TK_CLIPS_H

typedef enum {
    // Checksum words: TK_CLIP_WORD_0 + index, where index is the PGP "even" word (tk_word()).
    TK_CLIP_WORD_0 = 0,

    // Numbers: TK_CLIP_ZERO + n for n in 0..19, TK_CLIP_TWENTY + (tens - 2) for twenty..ninety.
    TK_CLIP_ZERO = 256,
    TK_CLIP_TWENTY = TK_CLIP_ZERO + 20,
    TK_CLIP_HUNDRED = TK_CLIP_TWENTY + 8,
    TK_CLIP_THOUSAND,
    TK_CLIP_MILLION,
    TK_CLIP_BILLION,
    TK_CLIP_TRILLION,
    TK_CLIP_POINT,

    // Letters: TK_CLIP_LETTER_A + (letter - 'A').
    TK_CLIP_LETTER_A,
    TK_CLIP_SPACE = TK_CLIP_LETTER_A + 26,
    TK_CLIP_HYPHEN,
    TK_CLIP_APOSTROPHE,

    // Tokens
    TK_CLIP_SOL,
    TK_CLIP_USDC,

    // Prompts
    TK_CLIP_SEND,
    TK_CLIP_TO,
    TK_CLIP_UNKNOWN_RECIPIENT, // "unknown recipient, do not sign"
    TK_CLIP_CANNOT_SIGN,       // "cannot sign this transaction"
    TK_CLIP_PRESS_CONFIRM,     // "press confirm to sign or reject to cancel"
    TK_CLIP_CHECKSUM,
    TK_CLIP_ADDRESS_PHRASE,
    TK_CLIP_ENTER_PIN,
    TK_CLIP_DIGIT,
    TK_CLIP_WRONG_PIN,
    TK_CLIP_ATTEMPTS_REMAINING,
    TK_CLIP_SIGNED,
    TK_CLIP_CANCELLED,
    TK_CLIP_ADDING_CONTACT,
    TK_CLIP_REMOVE,
    TK_CLIP_CONTACT_BOOK_FULL,
    TK_CLIP_ALREADY_A_CONTACT,
    TK_CLIP_RECOVERY_WORD,
    TK_CLIP_REPEAT,
    TK_CLIP_SPEAKER_MODE_ON,
    TK_CLIP_WALLET_WIPED,

    TK_CLIP_COUNT
} tk_clip_t;

#endif
