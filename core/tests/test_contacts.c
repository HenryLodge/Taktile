// Contact book tests: lookup vectors (tests/vectors/contacts.json), end to end with the parser
// vectors, name rules, duplicates, full table, removal, save/load, wipe.

#include <stdlib.h>

#include "tk_contacts.h"
#include "tk_contacts_vectors.h"
#include "tk_crc32.h"
#include "tk_parser.h"
#include "tk_parser_vectors.h"
#include "tk_test.h"

static const uint8_t ZERO_BOOK[sizeof(tk_contacts_t)];

#define NAME(s) (const uint8_t *)(s), (sizeof(s) - 1)

static void load_vector_book(tk_contacts_t *c, size_t n) {
    tk_contacts_init(c);
    for (size_t i = 0; i < n; i++) {
        const tk_contacts_book_entry_t *e = &tk_contacts_book[i];
        TK_CHECK(tk_contacts_add(c, (const uint8_t *)e->name, strlen(e->name), e->wallet) == TK_CONTACTS_OK);
    }
}

// A distinct, valid wallet for filler contacts (on-curve-ness doesn't matter to the book).
static void filler_wallet(uint8_t w[TK_PUBKEY_LEN], unsigned i) {
    memset(w, 0, TK_PUBKEY_LEN);
    w[0] = 0xF0;
    w[1] = (uint8_t)i;
}

static void filler_name(char name[16], unsigned i) {
    snprintf(name, 16, "Pal %u", i);
}

static void test_book_and_lookups(void) {
    tk_contacts_t c;
    load_vector_book(&c, TK_CONTACTS_BOOK_COUNT);
    TK_CHECK(c.count == TK_CONTACTS_BOOK_COUNT);
    for (size_t i = 0; i < TK_CONTACTS_BOOK_COUNT; i++) {
        TK_CHECK_MEM(c.items[i].usdc_ata, tk_contacts_book[i].usdc_ata, TK_PUBKEY_LEN);
        TK_CHECK(strcmp(c.items[i].name, tk_contacts_book[i].name) == 0);
    }
    int unknown = 0;
    for (size_t i = 0; i < TK_CONTACTS_LOOKUP_COUNT; i++) {
        const tk_contacts_lookup_vector_t *l = &tk_contacts_lookups[i];
        const int got = tk_contacts_find(&c, l->kind, l->destination);
        if (got != l->expect_index) {
            fprintf(stderr, "lookup %s: got %d, want %d\n", l->name, got, l->expect_index);
        }
        TK_CHECK(got == l->expect_index);
        unknown += l->expect_index < 0;
    }
    TK_CHECK(unknown >= 7);
    TK_CHECK(tk_contacts_find(&c, (tk_tx_kind_t)0, tk_contacts_book[0].wallet) == -1);
    TK_CHECK(tk_contacts_find(&c, TK_TX_SOL, NULL) == -1);
    TK_CHECK(tk_contacts_find(NULL, TK_TX_SOL, tk_contacts_book[0].wallet) == -1);
}

static void test_parser_end_to_end(void) {
    tk_contacts_t with, without;
    load_vector_book(&with, TK_CONTACTS_BOOK_COUNT);
    tk_contacts_init(&without);
    // Same book minus Alice: Bob and Carol only.
    for (size_t i = 1; i < TK_CONTACTS_BOOK_COUNT; i++) {
        const tk_contacts_book_entry_t *e = &tk_contacts_book[i];
        TK_CHECK(tk_contacts_add(&without, (const uint8_t *)e->name, strlen(e->name), e->wallet) == TK_CONTACTS_OK);
    }
    size_t resolved = 0;
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        const tk_parser_vector_t *v = &tk_parser_vectors[i];
        if (v->status != TK_STATUS_OK) {
            continue;
        }
        tk_tx_t tx;
        TK_CHECK(tk_parse_message(v->msg, v->msg_len, v->device_pubkey, v->device_usdc_ata, &tx) == TK_PARSE_OK);
        const int idx = tk_contacts_find(&with, tx.kind, tx.destination);
        TK_CHECK(idx == 0);
        if (idx == 0) {
            TK_CHECK(strcmp(with.items[0].name, "Alice") == 0);
        }
        TK_CHECK(tk_contacts_find(&without, tx.kind, tx.destination) == -1);
        resolved++;
    }
    TK_CHECK(resolved >= 6);
}

static void test_names(void) {
    static const struct {
        const char *s;
        size_t len; // 0: use strlen
        bool ok;
    } cases[] = {
        {"Al", 0, true},
        {"Mary-Jane", 0, true},
        {"O'Neil", 0, true},
        {"Bob 2", 0, true},
        {"Abcdefghijkl", 0, true}, // 12
        {"A", 0, true},
        {"", 0, false},
        {"Abcdefghijklm", 0, false}, // 13
        {" Al", 0, false},
        {"Al ", 0, false},
        {"Al  B", 0, false},
        {" ", 0, false},
        {"Al_B", 0, false},
        {"Al.B", 0, false},
        {"Al\tB", 0, false},
        {"Al\nB", 0, false},
        {"Al\0B", 4, false},
        {"Jos\xc3\xa9", 0, false}, // UTF-8 e-acute: bytes above 127
        {"\x7f", 0, false},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        const size_t len = cases[i].len ? cases[i].len : strlen(cases[i].s);
        const tk_contacts_result_t r = tk_contacts_validate_name((const uint8_t *)cases[i].s, len);
        if ((r == TK_CONTACTS_OK) != cases[i].ok) {
            fprintf(stderr, "name case %zu (\"%s\"): got %d\n", i, cases[i].s, (int)r);
        }
        TK_CHECK((r == TK_CONTACTS_OK) == cases[i].ok);
        if (!cases[i].ok) {
            TK_CHECK(r == TK_CONTACTS_NAME_INVALID);
        }
    }
    TK_CHECK(tk_contacts_validate_name(NULL, 3) == TK_CONTACTS_NAME_INVALID);
    // Every byte value as a one-character name: exactly the allowed set passes.
    for (unsigned b = 0; b < 256; b++) {
        const uint8_t ch = (uint8_t)b;
        const bool want = (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
                          b == '-' || b == '\'';
        TK_CHECK((tk_contacts_validate_name(&ch, 1) == TK_CONTACTS_OK) == want);
    }
}

// check_add must predict add exactly; on failure add must leave the table unchanged.
static tk_contacts_result_t add_checked(tk_contacts_t *c, const uint8_t *name, size_t len, const uint8_t *wallet) {
    tk_contacts_t before = *c;
    const tk_contacts_result_t predicted = tk_contacts_check_add(c, name, len, wallet);
    TK_CHECK(memcmp(&before, c, sizeof(before)) == 0);
    const tk_contacts_result_t r = tk_contacts_add(c, name, len, wallet);
    TK_CHECK(r == predicted);
    if (r != TK_CONTACTS_OK) {
        TK_CHECK(memcmp(&before, c, sizeof(before)) == 0);
    }
    return r;
}

static void test_duplicates_and_full(void) {
    tk_contacts_t c;
    tk_contacts_init(&c);
    const uint8_t *alice = tk_contacts_book[0].wallet;
    const uint8_t *bob = tk_contacts_book[1].wallet;
    TK_CHECK(add_checked(&c, NAME("Alice"), alice) == TK_CONTACTS_OK);
    TK_CHECK(add_checked(&c, NAME("alice"), bob) == TK_CONTACTS_NAME_EXISTS);
    TK_CHECK(add_checked(&c, NAME("ALICE"), bob) == TK_CONTACTS_NAME_EXISTS);
    TK_CHECK(add_checked(&c, NAME("Ally"), alice) == TK_CONTACTS_ADDRESS_EXISTS);
    TK_CHECK(add_checked(&c, NAME("Al_x"), bob) == TK_CONTACTS_NAME_INVALID);
    TK_CHECK(add_checked(&c, NAME("Alice B"), bob) == TK_CONTACTS_OK);
    TK_CHECK(c.count == 2);

    tk_contacts_init(&c);
    for (unsigned i = 0; i < TK_CONTACTS_MAX; i++) {
        char name[16];
        uint8_t w[TK_PUBKEY_LEN];
        filler_name(name, i);
        filler_wallet(w, i);
        TK_CHECK(add_checked(&c, (const uint8_t *)name, strlen(name), w) == TK_CONTACTS_OK);
    }
    TK_CHECK(c.count == TK_CONTACTS_MAX);
    TK_CHECK(add_checked(&c, NAME("Seventeen"), alice) == TK_CONTACTS_FULL);
    // A full table reports FULL even for a duplicate; an invalid name is reported first.
    TK_CHECK(add_checked(&c, NAME("Pal 0"), alice) == TK_CONTACTS_FULL);
    TK_CHECK(add_checked(&c, NAME(" x"), alice) == TK_CONTACTS_NAME_INVALID);

    TK_CHECK(tk_contacts_add(NULL, NAME("A"), alice) == TK_CONTACTS_BAD_ARG);
    TK_CHECK(tk_contacts_add(&c, NAME("A"), NULL) == TK_CONTACTS_BAD_ARG);
}

static void test_remove(void) {
    tk_contacts_t c;
    load_vector_book(&c, TK_CONTACTS_BOOK_COUNT); // Alice, Bob, Carol
    uint8_t dave[TK_PUBKEY_LEN];
    filler_wallet(dave, 99);
    TK_CHECK(tk_contacts_add(&c, NAME("Dave"), dave) == TK_CONTACTS_OK);

    TK_CHECK(tk_contacts_remove(&c, 4) == TK_CONTACTS_NOT_FOUND);
    TK_CHECK(tk_contacts_remove(&c, 255) == TK_CONTACTS_NOT_FOUND);
    TK_CHECK(tk_contacts_remove(&c, 1) == TK_CONTACTS_OK); // middle: Bob
    TK_CHECK(c.count == 3);
    TK_CHECK(strcmp(c.items[0].name, "Alice") == 0);
    TK_CHECK(strcmp(c.items[1].name, "Carol") == 0);
    TK_CHECK(strcmp(c.items[2].name, "Dave") == 0);
    TK_CHECK(tk_contacts_find(&c, TK_TX_SOL, tk_contacts_book[1].wallet) == -1);
    TK_CHECK(tk_contacts_find(&c, TK_TX_USDC, tk_contacts_book[1].usdc_ata) == -1);
    TK_CHECK(tk_contacts_find(&c, TK_TX_USDC, tk_contacts_book[2].usdc_ata) == 1);
    TK_CHECK(memcmp(&c.items[3], ZERO_BOOK, sizeof(c.items[3])) == 0);

    TK_CHECK(tk_contacts_remove(&c, 0) == TK_CONTACTS_OK); // first: Alice
    TK_CHECK(strcmp(c.items[0].name, "Carol") == 0);
    TK_CHECK(tk_contacts_remove(&c, 1) == TK_CONTACTS_OK); // last: Dave
    TK_CHECK(c.count == 1 && strcmp(c.items[0].name, "Carol") == 0);
    TK_CHECK(tk_contacts_get(&c, 0) == &c.items[0]);
    TK_CHECK(tk_contacts_get(&c, 1) == NULL);
    TK_CHECK(tk_contacts_remove(&c, 0) == TK_CONTACTS_OK);
    TK_CHECK(memcmp(&c, ZERO_BOOK, sizeof(c)) == 0);
    TK_CHECK(tk_contacts_remove(&c, 0) == TK_CONTACTS_NOT_FOUND);
    TK_CHECK(tk_contacts_remove(NULL, 0) == TK_CONTACTS_BAD_ARG);
    // A removed name and address can be added again.
    TK_CHECK(tk_contacts_add(&c, NAME("Bob"), tk_contacts_book[1].wallet) == TK_CONTACTS_OK);
}

static void test_status(void) {
    TK_CHECK(tk_contacts_status(TK_CONTACTS_OK) == TK_STATUS_OK);
    TK_CHECK(tk_contacts_status(TK_CONTACTS_FULL) == TK_STATUS_CONTACTS_FULL);
    TK_CHECK(tk_contacts_status(TK_CONTACTS_NAME_EXISTS) == TK_STATUS_CONTACT_EXISTS);
    TK_CHECK(tk_contacts_status(TK_CONTACTS_ADDRESS_EXISTS) == TK_STATUS_CONTACT_EXISTS);
    TK_CHECK(tk_contacts_status(TK_CONTACTS_NOT_FOUND) == TK_STATUS_NOT_FOUND);
    TK_CHECK(TK_STATUS_CONTACTS_FULL == 0x09 && TK_STATUS_CONTACT_EXISTS == 0x0A && TK_STATUS_NOT_FOUND == 0x0B);
}

static void full_book(tk_contacts_t *c) {
    load_vector_book(c, TK_CONTACTS_BOOK_COUNT);
    for (unsigned i = TK_CONTACTS_BOOK_COUNT; i < TK_CONTACTS_MAX; i++) {
        char name[16];
        uint8_t w[TK_PUBKEY_LEN];
        filler_name(name, i);
        filler_wallet(w, i);
        TK_CHECK(tk_contacts_add(c, (const uint8_t *)name, strlen(name), w) == TK_CONTACTS_OK);
    }
}

static void put_crc(uint8_t *blob) {
    const size_t body = TK_CONTACTS_BLOB_LEN - 4;
    const uint32_t crc = tk_crc32(blob, body);
    blob[body] = (uint8_t)crc;
    blob[body + 1] = (uint8_t)(crc >> 8);
    blob[body + 2] = (uint8_t)(crc >> 16);
    blob[body + 3] = (uint8_t)(crc >> 24);
}

static void expect_bad(const uint8_t *blob, size_t len) {
    tk_contacts_t c;
    memset(&c, 0x5A, sizeof(c));
    TK_CHECK(tk_contacts_load(&c, blob, len) == TK_CONTACTS_BAD_BLOB);
    TK_CHECK(memcmp(&c, ZERO_BOOK, sizeof(c)) == 0);
}

static void test_save_load(void) {
    static uint8_t blob[TK_CONTACTS_BLOB_LEN + 1];
    tk_contacts_t c, back;
    full_book(&c);
    TK_CHECK(tk_contacts_save(&c, blob, TK_CONTACTS_BLOB_LEN - 1) == 0);
    TK_CHECK(tk_contacts_save(&c, blob, sizeof(blob)) == TK_CONTACTS_BLOB_LEN);
    TK_CHECK(tk_contacts_load(&back, blob, TK_CONTACTS_BLOB_LEN) == TK_CONTACTS_OK);
    TK_CHECK(memcmp(&c, &back, sizeof(c)) == 0); // includes the re-derived usdc_ata

    // Empty and partial tables round-trip too.
    tk_contacts_t empty;
    tk_contacts_init(&empty);
    uint8_t eblob[TK_CONTACTS_BLOB_LEN];
    TK_CHECK(tk_contacts_save(&empty, eblob, sizeof(eblob)) == TK_CONTACTS_BLOB_LEN);
    TK_CHECK(tk_contacts_load(&back, eblob, sizeof(eblob)) == TK_CONTACTS_OK && back.count == 0);

    // Wrong lengths.
    expect_bad(blob, TK_CONTACTS_BLOB_LEN - 1);
    expect_bad(blob, TK_CONTACTS_BLOB_LEN + 1);
    expect_bad(NULL, TK_CONTACTS_BLOB_LEN);

    // Every single-byte change is rejected (CRC, or the checks behind it).
    uint8_t m[TK_CONTACTS_BLOB_LEN];
    for (size_t pos = 0; pos < TK_CONTACTS_BLOB_LEN; pos++) {
        memcpy(m, blob, sizeof(m));
        m[pos] ^= 0x01;
        expect_bad(m, sizeof(m));
    }

    // Valid CRC around invalid content.
    memcpy(m, blob, sizeof(m));
    m[4] = TK_CONTACTS_MAX + 1; // count 17
    put_crc(m);
    expect_bad(m, sizeof(m));

    memcpy(m, blob, sizeof(m));
    m[0] = 'X'; // magic
    put_crc(m);
    expect_bad(m, sizeof(m));

    uint8_t *slot1 = m + 5 + TK_CONTACTS_SLOT_LEN;
    memcpy(m, blob, sizeof(m));
    slot1[1] = '_'; // invalid name character in entry 1
    put_crc(m);
    expect_bad(m, sizeof(m));

    memcpy(m, blob, sizeof(m));
    memcpy(slot1, m + 5, TK_CONTACTS_SLOT_LEN); // entry 1 duplicates entry 0
    put_crc(m);
    expect_bad(m, sizeof(m));

    memcpy(m, blob, sizeof(m));
    memcpy(slot1 + 1 + TK_CONTACT_NAME_MAX, m + 5 + 1 + TK_CONTACT_NAME_MAX, TK_PUBKEY_LEN); // same wallet
    put_crc(m);
    expect_bad(m, sizeof(m));

    memcpy(m, blob, sizeof(m));
    slot1[0] = 0; // empty name
    put_crc(m);
    expect_bad(m, sizeof(m));

    memcpy(m, blob, sizeof(m));
    slot1[0] = TK_CONTACT_NAME_MAX + 1;
    put_crc(m);
    expect_bad(m, sizeof(m));

    // Bytes after the name, or in unused slots, must be zero.
    memcpy(m, eblob, sizeof(m));
    m[5 + 3] = 1;
    put_crc(m);
    expect_bad(m, sizeof(m));
    memcpy(m, blob, sizeof(m));
    m[5 + 1 + 5 + 1] = 'x'; // after "Alice" (5 chars) in entry 0
    put_crc(m);
    expect_bad(m, sizeof(m));

    // Random blobs, half with a valid CRC.
    uint32_t x = 0xC0FFEE22u;
    for (int iter = 0; iter < TK_TEST_ITERS(5000); iter++) {
        for (size_t b = 0; b < sizeof(m); b++) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            m[b] = (uint8_t)x;
        }
        m[0] = 'T';
        m[1] = 'K';
        m[2] = 'C';
        m[3] = '1';
        m[4] %= TK_CONTACTS_MAX + 1;
        if (iter % 2 == 0) {
            put_crc(m);
        }
        expect_bad(m, sizeof(m));
    }
    TK_CHECK(tk_contacts_load(NULL, blob, TK_CONTACTS_BLOB_LEN) == TK_CONTACTS_BAD_ARG);
    TK_CHECK(tk_contacts_save(NULL, blob, sizeof(blob)) == 0);
}

static void test_wipe(void) {
    tk_contacts_t c;
    full_book(&c);
    tk_contacts_wipe(&c);
    TK_CHECK(memcmp(&c, ZERO_BOOK, sizeof(c)) == 0);
}

int main(void) {
    test_book_and_lookups();
    test_parser_end_to_end();
    test_names();
    test_duplicates_and_full();
    test_remove();
    test_status();
    test_save_load();
    test_wipe();
    return tk_test_result();
}
