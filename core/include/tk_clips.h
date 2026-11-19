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
    TK_CLIP_DIGIT, // "pin digit number" (then the position, "starting at", the private start digit)
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

    // SETUP (core/src/tk_setup.c), and speaker mode off (P1)
    TK_CLIP_WRITE_DOWN,      // "write down your recovery words"
    TK_CLIP_NEXT_WORD_HELP,  // "press OK for the next word, hold OK to repeat"
    TK_CLIP_REPLAY_ALL,      // "hold OK to hear all words again, or press OK to finish"
    TK_CLIP_CHOOSE_PIN,      // "choose a new PIN"
    TK_CLIP_ENTER_PIN_AGAIN, // "enter your PIN again"
    TK_CLIP_PINS_DONT_MATCH, // "the PINs do not match"
    TK_CLIP_PLEASE_WAIT,
    TK_CLIP_WALLET_CREATED,
    TK_CLIP_SPEAKER_MODE_OFF,

    TK_CLIP_STARTING_AT, // PIN entry: "pin digit number three, starting at <digit>"
    // Recovery word positions 21-24 as one phrase each: TK_CLIP_TWENTY_ONE + (n - 21). Two clips
    // ("twenty", "one") ran into the spelled letters that follow.
    TK_CLIP_TWENTY_ONE,

    // CONTACT_ADD (core/src/tk_enroll.c)
    TK_CLIP_PRESS_CONFIRM_ADD = TK_CLIP_TWENTY_ONE + 4, // "press confirm to add or reject to cancel"
    TK_CLIP_CONTACT_ADDED,

    // UNLOCK (core/src/tk_flow.c)
    TK_CLIP_UNLOCKED, // "wallet unlocked"

    // Voice commands: SPEAK_ADDRESS, SPEAK_CONTACTS, LOCK (core/src/tk_flow.c)
    TK_CLIP_YOUR_ADDRESS_PHRASE_IS, // "your address phrase is"
    TK_CLIP_YOU_HAVE,               // "you have" (then a number and "contacts")
    TK_CLIP_CONTACTS,               // "contacts"
    TK_CLIP_WALLET_LOCKED,          // "wallet locked"

    TK_CLIP_COUNT
} tk_clip_t;

#endif
