// CONTACT_ADD flow (core/src/tk_enroll.c), driven through the fake platform and fake wallet, plus
// one case on the real key store.

#include <stdlib.h>

#include "tk_checksum.h"
#include "tk_checksum_vectors.h"
#include "tk_clips.h"
#include "tk_contacts_vectors.h"
#include "tk_device.h"
#include "tk_fakes.h"
#include "tk_keystore.h"
#include "tk_parser_vectors.h"
#include "tk_test.h"

#define SEQ 0x51

static tk_contacts_t book;
static tk_device_t dev;
static out_frame_t frames[256];
static size_t nframes;

static void setup(bool has_wallet, bool unlocked) {
    fake_reset();
    fake_wallet_reset(has_wallet, unlocked);
    tk_contacts_init(&book);
    tk_device_init(&dev, &FAKE_PLATFORM, &FAKE_WALLET, &book);
}

static void run(void) {
    tk_device_poll(&dev);
    nframes = fake_output(frames, sizeof(frames) / sizeof(frames[0]));
}

static const tk_contacts_book_entry_t *entry(const char *name) {
    for (size_t i = 0; i < TK_CONTACTS_BOOK_COUNT; i++) {
        if (strcmp(tk_contacts_book[i].name, name) == 0) {
            return &tk_contacts_book[i];
        }
    }
    fprintf(stderr, "no contacts vector %s\n", name);
    abort();
}

// CONTACT_ADD payload: name_len, name, wallet[32].
static size_t payload(const char *name, const uint8_t wallet[32], uint8_t *out) {
    const size_t n = strlen(name);
    out[0] = (uint8_t)n;
    memcpy(out + 1, name, n);
    memcpy(out + 1 + n, wallet, 32);
    return 1 + n + 32;
}

static void contact_add(const char *name, const uint8_t wallet[32]) {
    uint8_t p[64];
    const size_t n = payload(name, wallet, p);
    fake_send_now(TK_MSG_CONTACT_ADD, SEQ, p, n);
}

static void script_correct_pin(void) {
    for (int d = 1; d <= 6; d++) {
        for (int i = 0; i < d; i++) {
            fake_press(TK_BTN_UP);
        }
        fake_press(TK_BTN_OK);
    }
}

static void script_wrong_pin(void) {
    for (int d = 0; d < 6; d++) {
        fake_press(TK_BTN_OK);
    }
}

static bool has_frame(uint8_t type, uint8_t seq, const uint8_t *p, size_t len) {
    for (size_t i = 0; i < nframes; i++) {
        if (frames[i].type == type && frames[i].seq == seq && frames[i].len == len &&
            (len == 0 || memcmp(frames[i].payload, p, len) == 0)) {
            return true;
        }
    }
    return false;
}

// The status of the single CONTACT_ADD reply with our seq; -1 unless exactly one exists.
static int reply_status(void) {
    int status = -1, count = 0;
    for (size_t i = 0; i < nframes; i++) {
        if (frames[i].type == (TK_MSG_CONTACT_ADD | TK_MSG_RESPONSE_BIT) && frames[i].seq == SEQ) {
            status = frames[i].len == 1 ? frames[i].payload[0] : -2;
            count++;
        }
    }
    return count == 1 ? status : -1;
}

static size_t clip_count(uint16_t clip) {
    size_t n = 0;
    for (size_t i = 0; i < fake_op_count; i++) {
        n += fake_ops[i].kind == OP_CLIP && fake_ops[i].value == clip;
    }
    return n;
}

static size_t all_clips(void) {
    size_t n = 0;
    for (size_t i = 0; i < fake_op_count; i++) {
        n += fake_ops[i].kind == OP_CLIP;
    }
    return n;
}

static size_t event_count(void) {
    size_t n = 0;
    for (size_t i = 0; i < nframes; i++) {
        n += frames[i].type == TK_MSG_EVENT;
    }
    return n;
}

static bool any_secret_clip(void) {
    for (size_t i = 0; i < fake_op_count; i++) {
        if (fake_ops[i].kind == OP_CLIP && fake_ops[i].secret) {
            return true;
        }
    }
    return false;
}

// Index in fake_ops of the n-th (0-based) occurrence of clip, or -1.
static int clip_at(uint16_t clip, int nth) {
    for (size_t i = 0; i < fake_op_count; i++) {
        if (fake_ops[i].kind == OP_CLIP && fake_ops[i].value == clip && nth-- == 0) {
            return (int)i;
        }
    }
    return -1;
}

static const tk_checksum_addr_vector_t *addr_vec(const char *name) {
    for (size_t i = 0; i < TK_CHECKSUM_ADDR_VECTOR_COUNT; i++) {
        if (strcmp(tk_checksum_addr_vectors[i].name, name) == 0) {
            return &tk_checksum_addr_vectors[i];
        }
    }
    fprintf(stderr, "no addr vector %s\n", name);
    abort();
}

// The clips of "adding contact <spelled name>, address phrase <8 words>" starting at fake_ops[i].
static bool announcement_at(size_t i, const char *spelled_upper, const uint8_t words[8]) {
    uint16_t want[64];
    size_t n = 0;
    want[n++] = TK_CLIP_ADDING_CONTACT;
    for (const char *c = spelled_upper; *c != '\0'; c++) {
        want[n++] = (uint16_t)(TK_CLIP_LETTER_A + (*c - 'A'));
    }
    want[n++] = TK_CLIP_ADDRESS_PHRASE;
    for (size_t k = 0; k < 8; k++) {
        want[n++] = (uint16_t)(TK_CLIP_WORD_0 + words[k]);
    }
    size_t got = 0;
    for (; i < fake_op_count && got < n; i++) {
        if (fake_ops[i].kind != OP_CLIP) {
            continue;
        }
        if (fake_ops[i].value != want[got] || fake_ops[i].secret) {
            return false;
        }
        got++;
    }
    return got == n;
}

static bool saved_book_matches(void) {
    tk_contacts_t reloaded;
    return fake.stored_set && tk_contacts_load(&reloaded, fake.stored, fake.stored_len) == TK_CONTACTS_OK &&
           reloaded.count == book.count && memcmp(reloaded.items, book.items, sizeof(book.items)) == 0;
}

// ---- Tests ----

static void test_happy_unlocked(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    const tk_checksum_addr_vector_t *av = addr_vec("alice");
    TK_CHECK_MEM(av->wallet, a->wallet, 32); // the vectors describe the same wallet
    setup(true, true);
    contact_add("Alice", a->wallet);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_OK);
    TK_CHECK(announcement_at(0, "ALICE", av->indices)); // public clips, in order (Q-G)
    TK_CHECK(!any_secret_clip());
    TK_CHECK(clip_count(TK_CLIP_ENTER_PIN) == 0 && fw.unlock_calls == 0);
    TK_CHECK(clip_count(TK_CLIP_PRESS_CONFIRM_ADD) == 1 && clip_count(TK_CLIP_PRESS_CONFIRM) == 0);
    TK_CHECK(clip_count(TK_CLIP_CONTACT_ADDED) == 1 && clip_count(TK_CLIP_SIGNED) == 0);
    const uint8_t ann = TK_EVENT_ANNOUNCING, conf = TK_EVENT_AWAITING_CONFIRM;
    TK_CHECK(has_frame(TK_MSG_EVENT, SEQ, &ann, 1) && has_frame(TK_MSG_EVENT, SEQ, &conf, 1));
    TK_CHECK(book.count == 1 && strcmp(book.items[0].name, "Alice") == 0);
    TK_CHECK_MEM(book.items[0].wallet, a->wallet, 32);
    TK_CHECK_MEM(book.items[0].usdc_ata, a->usdc_ata, 32); // derived on device
    TK_CHECK(saved_book_matches());
    TK_CHECK(fw.unlocked && fw.sign_calls == 0); // not a signature: the session stays
    // CONFIRM came after "press confirm to add" (I6).
    int last_clip = -1;
    for (size_t i = 0; i < fake_op_count; i++) {
        if (fake_ops[i].kind == OP_CLIP) {
            last_clip = fake_ops[i].value;
        } else if (fake_ops[i].kind == OP_BUTTON && fake_ops[i].value == TK_BTN_CONFIRM) {
            TK_CHECK(last_clip == TK_CLIP_PRESS_CONFIRM_ADD);
        }
    }

    // The name as sent is kept (any case), spelled in capitals; a second contact is appended.
    const tk_contacts_book_entry_t *b = entry("Bob");
    const tk_checksum_addr_vector_t *bv = addr_vec("bob");
    TK_CHECK_MEM(bv->wallet, b->wallet, 32);
    fake_op_count = 0;
    fake.tx_len = 0;
    contact_add("bob-o'b 2", b->wallet);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_OK);
    TK_CHECK(book.count == 2 && strcmp(book.items[1].name, "bob-o'b 2") == 0);
    TK_CHECK(clip_count(TK_CLIP_HYPHEN) == 1 && clip_count(TK_CLIP_APOSTROPHE) == 1 &&
             clip_count(TK_CLIP_ZERO + 2) == 1);
    TK_CHECK(!any_secret_clip());
    TK_CHECK(saved_book_matches());
}

static void test_locked_asks_pin_after_announcement(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    setup(true, false);
    contact_add("Alice", a->wallet);
    script_wrong_pin();
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_OK && book.count == 1);
    TK_CHECK(fw.unlock_calls == 2 && clip_count(TK_CLIP_WRONG_PIN) == 1 && clip_count(TK_CLIP_PLEASE_WAIT) == 2);
    const int phrase = clip_at(TK_CLIP_ADDRESS_PHRASE, 0), pin = clip_at(TK_CLIP_ENTER_PIN, 0),
              confirm = clip_at(TK_CLIP_PRESS_CONFIRM_ADD, 0);
    TK_CHECK(phrase >= 0 && pin > phrase && confirm > clip_at(TK_CLIP_ENTER_PIN, 1));
    const uint8_t awaiting_pin = TK_EVENT_AWAITING_PIN;
    TK_CHECK(has_frame(TK_MSG_EVENT, SEQ, &awaiting_pin, 1));
    TK_CHECK(fw.unlocked); // still unlocked after the add

    // PIN entry rejected (REJECT): REJECTED_BY_USER, nothing stored.
    setup(true, false);
    contact_add("Alice", a->wallet);
    fake_press(TK_BTN_REJECT);
    run();
    TK_CHECK(reply_status() == TK_STATUS_REJECTED_BY_USER && book.count == 0 && fake.set_count == 0);

    // The key store can't check a PIN: DEVICE_ERROR, nothing stored.
    setup(true, false);
    fw.unlock_error = true;
    contact_add("Alice", a->wallet);
    script_correct_pin();
    run();
    TK_CHECK(reply_status() == TK_STATUS_DEVICE_ERROR && book.count == 0 && fake.set_count == 0);
    // Nothing is being signed, so it says "cancelled", not "cannot sign this transaction".
    TK_CHECK(clip_count(TK_CLIP_CANCELLED) == 1 && clip_count(TK_CLIP_CANNOT_SIGN) == 0);
}

// The real key store: ten wrong PINs wipe the wallet and the contact book; nothing is added.
static void test_keystore_lockout(void) {
    fake_reset();
    fake_wallet_reset(false, false);
    uint8_t salt[TK_KEYSTORE_SALT_LEN] = {7};
    uint8_t blob[TK_KEYSTORE_BLOB_LEN];
    static const uint8_t pin[TK_PIN_LEN] = {1, 2, 3, 4, 5, 6};
    TK_CHECK(tk_keystore_seal(pin, fw.sk, fw.pk, salt, TK_KDF_ITERS_MIN, blob));
    fake_kv_put(TK_STORAGE_WALLET, blob, sizeof(blob));
    const uint8_t zero = 0;
    fake_kv_put(TK_STORAGE_PIN_FAILS, &zero, 1);
    static tk_keystore_t ks;
    tk_wallet_ops_t ops;
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ops);
    tk_contacts_init(&book);
    const tk_contacts_book_entry_t *a = entry("Alice"), *b = entry("Bob");
    TK_CHECK(tk_contacts_add(&book, (const uint8_t *)a->name, strlen(a->name), a->wallet) == TK_CONTACTS_OK);
    tk_device_init(&dev, &FAKE_PLATFORM, &ops, &book);

    contact_add("Bob", b->wallet);
    for (int i = 0; i < 10; i++) {
        script_wrong_pin();
    }
    run();
    TK_CHECK(reply_status() == TK_STATUS_LOCKED_OUT);
    TK_CHECK(clip_count(TK_CLIP_WALLET_WIPED) == 1 && clip_count(TK_CLIP_PRESS_CONFIRM_ADD) == 0);
    TK_CHECK(!ops.has_wallet(ops.ctx) && book.count == 0);
    tk_contacts_t reloaded;
    TK_CHECK(fake.stored_set && tk_contacts_load(&reloaded, fake.stored, fake.stored_len) == TK_CONTACTS_OK &&
             reloaded.count == 0);

    // The right PIN instead: added, and the key store stays unlocked (only signing locks it).
    fake_reset();
    fake_kv_put(TK_STORAGE_WALLET, blob, sizeof(blob));
    fake_kv_put(TK_STORAGE_PIN_FAILS, &zero, 1);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ops);
    tk_contacts_init(&book);
    tk_device_init(&dev, &FAKE_PLATFORM, &ops, &book);
    contact_add("Bob", b->wallet);
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_OK && book.count == 1 && ops.is_unlocked(ops.ctx));
    TK_CHECK(saved_book_matches());
    tk_keystore_lock(&ks);
}

// Every ending other than CONFIRM: the right status, the book unchanged, storage never written.
static void test_nothing_stored_unless_ok(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    static const struct {
        tk_button_t button; // TK_BTN_NONE: no press (timeout)
        int status;
    } endings[] = {
        {TK_BTN_REJECT, TK_STATUS_REJECTED_BY_USER},
        {TK_BTN_NONE, TK_STATUS_REJECTED_BY_USER},
        {TK_BTN_REJECT_LONG, TK_STATUS_CANCELLED},
    };
    for (size_t i = 0; i < sizeof(endings) / sizeof(endings[0]); i++) {
        setup(true, true);
        contact_add("Alice", a->wallet);
        if (endings[i].button != TK_BTN_NONE) {
            fake_press(endings[i].button);
        }
        const uint32_t t0 = fake.now;
        run();
        TK_CHECK(reply_status() == endings[i].status);
        TK_CHECK(book.count == 0 && fake.set_count == 0 && !fake.stored_set);
        TK_CHECK(clip_count(TK_CLIP_CONTACT_ADDED) == 0 && clip_count(TK_CLIP_CANCELLED) == 1);
        if (endings[i].button == TK_BTN_NONE) {
            TK_CHECK(fake.now - t0 >= TK_CONFIRM_TIMEOUT_MS); // the 30 s window (I6)
        }
    }

    // Host CANCEL during the announcement: it stops talking, CANCEL gets OK, the add gets CANCELLED.
    setup(true, true);
    contact_add("Alice", a->wallet);
    fake_frame(TK_MSG_CANCEL, 9, NULL, 0);
    fake_press(TK_BTN_CONFIRM); // must never be reached
    run();
    const uint8_t ok = TK_STATUS_OK;
    TK_CHECK(has_frame(TK_MSG_CANCEL | TK_MSG_RESPONSE_BIT, 9, &ok, 1));
    TK_CHECK(reply_status() == TK_STATUS_CANCELLED && book.count == 0 && fake.set_count == 0);
    TK_CHECK(clip_count(TK_CLIP_PRESS_CONFIRM_ADD) == 0);
    TK_CHECK(all_clips() < 6); // cut short: the 8 words were not all played

    // Host CANCEL during PIN entry.
    setup(true, false);
    contact_add("Alice", a->wallet);
    fake_press(TK_BTN_UP);
    fake_frame(TK_MSG_CANCEL, 10, NULL, 0);
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(has_frame(TK_MSG_CANCEL | TK_MSG_RESPONSE_BIT, 10, &ok, 1));
    TK_CHECK(reply_status() == TK_STATUS_CANCELLED && book.count == 0 && fake.set_count == 0);
    TK_CHECK(fw.unlock_calls == 0);
}

// I6: a CONFIRM pressed while the announcement plays is discarded; it never adds the contact.
static void test_press_ahead_ignored(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    setup(true, true);
    contact_add("Alice", a->wallet);
    fake_press_during_clip(TK_BTN_CONFIRM);
    run();
    TK_CHECK(fake.discarded_presses == 1);
    TK_CHECK(reply_status() == TK_STATUS_REJECTED_BY_USER && book.count == 0 && fake.set_count == 0);
}

// Hold OK in the confirm window repeats the whole announcement and restarts the 30 s.
static void test_hold_ok_repeats(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    const tk_checksum_addr_vector_t *av = addr_vec("alice");
    setup(true, true);
    contact_add("Alice", a->wallet);
    fake_advance(TK_CONFIRM_TIMEOUT_MS - 1000);
    fake_press(TK_BTN_OK_LONG);
    fake_advance(TK_CONFIRM_TIMEOUT_MS - 1000); // only fits in a fresh window
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_OK && book.count == 1);
    TK_CHECK(clip_count(TK_CLIP_ADDING_CONTACT) == 2 && clip_count(TK_CLIP_PRESS_CONFIRM_ADD) == 2);
    TK_CHECK(announcement_at((size_t)clip_at(TK_CLIP_ADDING_CONTACT, 1), "ALICE", av->indices));
}

// Refused up front: no flow (no events), nothing stored.
static void test_refusals(void) {
    const tk_contacts_book_entry_t *a = entry("Alice"), *b = entry("Bob");

    // Book full: 16 contacts.
    setup(true, true);
    for (int i = 0; i < (int)TK_CONTACTS_MAX; i++) {
        uint8_t w[32];
        memcpy(w, a->wallet, 32);
        w[31] ^= (uint8_t)(i + 1);
        char name[8];
        snprintf(name, sizeof(name), "C%d", i);
        TK_CHECK(tk_contacts_add(&book, (const uint8_t *)name, strlen(name), w) == TK_CONTACTS_OK);
    }
    contact_add("Bob", b->wallet);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_CONTACTS_FULL && book.count == TK_CONTACTS_MAX);
    TK_CHECK(clip_count(TK_CLIP_CONTACT_BOOK_FULL) == 1 && all_clips() == 1 && event_count() == 0);
    TK_CHECK(fake.set_count == 0 && fake.cursor == 0); // the CONFIRM was never read

    // Same name ignoring case, or same wallet: "already a contact".
    setup(true, true);
    TK_CHECK(tk_contacts_add(&book, (const uint8_t *)"Alice", 5, a->wallet) == TK_CONTACTS_OK);
    contact_add("ALICE", b->wallet);
    run();
    TK_CHECK(reply_status() == TK_STATUS_CONTACT_EXISTS && clip_count(TK_CLIP_ALREADY_A_CONTACT) == 1);
    TK_CHECK(all_clips() == 1 && event_count() == 0 && fake.set_count == 0 && book.count == 1);
    fake_op_count = 0;
    fake.tx_len = 0;
    contact_add("Al", a->wallet);
    run();
    TK_CHECK(reply_status() == TK_STATUS_CONTACT_EXISTS && clip_count(TK_CLIP_ALREADY_A_CONTACT) == 1);
    TK_CHECK(all_clips() == 1 && event_count() == 0 && fake.set_count == 0 && book.count == 1);

    // No wallet: NO_WALLET, silent.
    setup(false, false);
    contact_add("Alice", a->wallet);
    run();
    TK_CHECK(reply_status() == TK_STATUS_NO_WALLET && all_clips() == 0 && event_count() == 0);

    // No audio: DEVICE_ERROR, nothing played.
    setup(true, true);
    fake.audio_bad = true;
    contact_add("Alice", a->wallet);
    run();
    TK_CHECK(reply_status() == TK_STATUS_DEVICE_ERROR && all_clips() == 0 && event_count() == 0);
    TK_CHECK(book.count == 0 && fake.set_count == 0);
}

// Malformed payloads: ERROR{BAD_PAYLOAD}, no audio, no flow, nothing stored.
static void test_bad_payloads(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    uint8_t p[80];
    size_t n = payload("Alice", a->wallet, p);
    struct {
        const char *what;
        uint8_t buf[80];
        size_t len;
    } cases[16];
    size_t nc = 0;
#define ADD_CASE(desc, src, l)                       \
    do {                                             \
        cases[nc].what = (desc);                     \
        memcpy(cases[nc].buf, (src), (l));           \
        cases[nc].len = (l);                         \
        nc++;                                        \
    } while (0)
    ADD_CASE("empty", p, 0);
    ADD_CASE("name_len only", p, 1);
    ADD_CASE("one byte short", p, n - 1);
    uint8_t q[80];
    memcpy(q, p, n);
    q[n] = 0;
    ADD_CASE("one byte long", q, n + 1);
    memcpy(q, p, n);
    q[0] = 4; // claims 4: length no longer matches
    ADD_CASE("name_len too small", q, n);
    memcpy(q, p, n);
    q[0] = 6;
    ADD_CASE("name_len too big", q, n);
    q[0] = 0;
    memcpy(q + 1, a->wallet, 32);
    ADD_CASE("name_len 0", q, 33);
    n = payload("ABCDEFGHIJKLM", a->wallet, q); // 13 characters
    ADD_CASE("13 characters", q, n);
    n = payload("Al!ce", a->wallet, q);
    ADD_CASE("bad character", q, n);
    n = payload(" Alice", a->wallet, q);
    ADD_CASE("leading space", q, n);
    n = payload("Al  ice", a->wallet, q);
    ADD_CASE("double space", q, n);
    n = payload("Alice ", a->wallet, q);
    ADD_CASE("trailing space", q, n);
    n = payload("Al\xe9", a->wallet, q);
    ADD_CASE("non-ASCII", q, n);
#undef ADD_CASE
    const uint8_t bad = TK_PROTO_ERR_BAD_PAYLOAD;
    for (size_t i = 0; i < nc; i++) {
        setup(true, true);
        fake_send_now(TK_MSG_CONTACT_ADD, SEQ, cases[i].buf, cases[i].len);
        fake_press(TK_BTN_CONFIRM);
        run();
        const bool ok = nframes == 1 && has_frame(TK_MSG_ERROR, SEQ, &bad, 1) && all_clips() == 0 && fake.cursor == 0 &&
                        book.count == 0 && fake.set_count == 0;
        if (!ok) {
            fprintf(stderr, "bad payload case: %s\n", cases[i].what);
        }
        TK_CHECK(ok);
    }
}

// Saving fails: DEVICE_ERROR, and the contact is taken out of RAM again (RAM matches flash).
static void test_storage_failure(void) {
    const tk_contacts_book_entry_t *a = entry("Alice"), *b = entry("Bob");
    setup(true, true);
    TK_CHECK(tk_contacts_add(&book, (const uint8_t *)"Bob", 3, b->wallet) == TK_CONTACTS_OK);
    const tk_contacts_t before = book;
    fake.fail_set_key = TK_STORAGE_CONTACTS;
    contact_add("Alice", a->wallet);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_DEVICE_ERROR);
    TK_CHECK(memcmp(&book, &before, sizeof(book)) == 0);
    TK_CHECK(fake.set_count == 1 && !fake.stored_set && clip_count(TK_CLIP_CONTACT_ADDED) == 0);
}

// During the flow: HELLO is answered, other requests get BUSY, a CANCEL ends it.
static void test_requests_during_flow(void) {
    const tk_contacts_book_entry_t *a = entry("Alice");
    setup(true, true);
    contact_add("Alice", a->wallet);
    fake_frame(TK_MSG_HELLO, 1, NULL, 0);
    fake_frame(TK_MSG_GET_PUBKEY, 2, NULL, 0);
    uint8_t p[64];
    const size_t n = payload("Bob", entry("Bob")->wallet, p);
    fake_frame(TK_MSG_CONTACT_ADD, 3, p, n);
    fake_press(TK_BTN_CONFIRM);
    run();
    const uint8_t hello[4] = {1, 0, 1, TK_STATE_UNLOCKED}, busy = TK_STATUS_BUSY;
    TK_CHECK(has_frame(TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, 1, hello, 4));
    TK_CHECK(has_frame(TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, 2, &busy, 1));
    TK_CHECK(has_frame(TK_MSG_CONTACT_ADD | TK_MSG_RESPONSE_BIT, 3, &busy, 1));
    TK_CHECK(reply_status() == TK_STATUS_OK && book.count == 1);
}

// I3: once added, a SOL transfer to that wallet is announced with the stored name.
static void test_added_contact_is_announced(void) {
    const tk_parser_vector_t *v = NULL;
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        if (strcmp(tk_parser_vectors[i].name, "sol_ok") == 0) {
            v = &tk_parser_vectors[i];
        }
    }
    TK_CHECK(v != NULL);
    if (v == NULL) {
        return;
    }
    const tk_contacts_book_entry_t *a = entry("Alice");
    setup(true, true);
    contact_add("Zed", a->wallet); // the destination of sol_ok, under another name
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_OK);
    fake_op_count = 0;
    fake_send_now(TK_MSG_SIGN_REQUEST, 0x60, v->msg, v->msg_len);
    fake_press(TK_BTN_CONFIRM);
    run();
    const int to = clip_at(TK_CLIP_TO, 0);
    TK_CHECK(to >= 0 && to + 3 < (int)fake_op_count);
    if (to >= 0 && to + 3 < (int)fake_op_count) {
        TK_CHECK(fake_ops[to + 1].value == TK_CLIP_LETTER_A + 25 && fake_ops[to + 2].value == TK_CLIP_LETTER_A + 4 &&
                 fake_ops[to + 3].value == TK_CLIP_LETTER_A + 3);
    }
    TK_CHECK(fw.sign_calls == 1);
}

int main(void) {
    test_happy_unlocked();
    test_locked_asks_pin_after_announcement();
    test_keystore_lockout();
    test_nothing_stored_unless_ok();
    test_press_ahead_ignored();
    test_hold_ok_repeats();
    test_refusals();
    test_bad_payloads();
    test_storage_failure();
    test_requests_during_flow();
    test_added_contact_is_announced();
    return tk_test_result();
}
