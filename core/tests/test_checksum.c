// Checksum phrase tests against tests/vectors/checksum.json (generated with node:crypto, and also
// checked by app/src/checksum.test.ts, so device and app must agree).

#include "tk_checksum.h"
#include "tk_checksum_vectors.h"
#include "tk_test.h"

static void test_tx_vectors(void) {
    for (size_t i = 0; i < TK_CHECKSUM_TX_VECTOR_COUNT; i++) {
        const tk_checksum_tx_vector_t *v = &tk_checksum_tx_vectors[i];
        uint8_t w[TK_TX_PHRASE_WORDS];
        tk_checksum_tx(v->msg, v->msg_len, w);
        if (memcmp(w, v->indices, sizeof(w)) != 0) {
            fprintf(stderr, "tx vector %s: got %u %u %u\n", v->name, w[0], w[1], w[2]);
        }
        TK_CHECK_MEM(w, v->indices, sizeof(w));
        for (size_t k = 0; k < TK_TX_PHRASE_WORDS; k++) {
            TK_CHECK(strcmp(tk_word(w[k]), v->words[k]) == 0);
        }
    }
    TK_CHECK(TK_CHECKSUM_TX_VECTOR_COUNT >= 8);
}

static void test_addr_vectors(void) {
    for (size_t i = 0; i < TK_CHECKSUM_ADDR_VECTOR_COUNT; i++) {
        const tk_checksum_addr_vector_t *v = &tk_checksum_addr_vectors[i];
        uint8_t w[TK_ADDR_PHRASE_WORDS];
        tk_checksum_addr(v->wallet, w);
        if (memcmp(w, v->indices, sizeof(w)) != 0) {
            fprintf(stderr, "addr vector %s: mismatch\n", v->name);
        }
        TK_CHECK_MEM(w, v->indices, sizeof(w));
        for (size_t k = 0; k < TK_ADDR_PHRASE_WORDS; k++) {
            TK_CHECK(strcmp(tk_word(w[k]), v->words[k]) == 0);
        }
    }
    TK_CHECK(TK_CHECKSUM_ADDR_VECTOR_COUNT >= 6);
}

static const tk_checksum_tx_vector_t *find_tx(const char *name) {
    for (size_t i = 0; i < TK_CHECKSUM_TX_VECTOR_COUNT; i++) {
        if (strcmp(tk_checksum_tx_vectors[i].name, name) == 0) {
            return &tk_checksum_tx_vectors[i];
        }
    }
    return NULL;
}

static void test_edges(void) {
    // NULL with length 0 is the empty message. Anchored independently: the first three bytes of
    // `printf 'TK-TX-v1' | sha256sum` are 47 24 5a.
    const tk_checksum_tx_vector_t *empty = find_tx("empty");
    TK_CHECK(empty != NULL);
    uint8_t w[TK_TX_PHRASE_WORDS];
    tk_checksum_tx(NULL, 0, w);
    static const uint8_t want_empty[TK_TX_PHRASE_WORDS] = {0x47, 0x24, 0x5a};
    TK_CHECK_MEM(w, want_empty, sizeof(w));
    if (empty != NULL) {
        TK_CHECK_MEM(w, empty->indices, sizeof(w));
    }

    // One amount bit changes the phrase.
    const tk_checksum_tx_vector_t *a = find_tx("sol_ok");
    const tk_checksum_tx_vector_t *b = find_tx("sol_ok_amount_bit_flipped");
    TK_CHECK(a != NULL && b != NULL);
    if (a != NULL && b != NULL) {
        TK_CHECK(memcmp(a->indices, b->indices, TK_TX_PHRASE_WORDS) != 0);
    }
}

static void test_words(void) {
    TK_CHECK(strcmp(tk_word(0x00), "aardvark") == 0);
    TK_CHECK(strcmp(tk_word(0xE5), "topmost") == 0);
    TK_CHECK(strcmp(tk_word(0xFF), "Zulu") == 0);
    for (unsigned i = 0; i < TK_WORD_COUNT; i++) {
        const char *s = tk_word((uint8_t)i);
        TK_CHECK(s != NULL && s[0] != '\0');
    }
}

int main(void) {
    test_tx_vectors();
    test_addr_vectors();
    test_edges();
    test_words();
    return tk_test_result();
}
