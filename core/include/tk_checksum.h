// Checksum phrases (docs/AUDIO.md). The app computes the same phrases (app/src/checksum.ts);
// tests/vectors/checksum.json keeps the two in step.
//
//   tx phrase:      SHA256("TK-TX-v1"   || message_bytes)  -> bytes 0..2 are the word indices
//   address phrase: SHA256("TK-ADDR-v1" || wallet_pubkey)  -> bytes 0..7 are the word indices
//
// Tags are ASCII without a trailing NUL. message_bytes is the SIGN_REQUEST payload (the Solana
// message). Phrases are private earpiece audio (SECURITY_MODEL I2): never log or send them.

#ifndef TK_CHECKSUM_H
#define TK_CHECKSUM_H

#include <stddef.h>
#include <stdint.h>

#include "tk_solana_consts.h"
#include "tk_words.h"

#define TK_TX_PHRASE_WORDS 3u
#define TK_ADDR_PHRASE_WORDS 8u

// Word indices for tk_word(). msg may be NULL only when len is 0.
void tk_checksum_tx(const uint8_t *msg, size_t len, uint8_t words[TK_TX_PHRASE_WORDS]);
void tk_checksum_addr(const uint8_t wallet[TK_PUBKEY_LEN], uint8_t words[TK_ADDR_PHRASE_WORDS]);

#endif
