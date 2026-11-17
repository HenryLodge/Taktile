// SIGN_REQUEST flow and request dispatch, driven through the fake platform and fake wallet.

#include <stdlib.h>

#include "tk_checksum.h"
#include "tk_contacts_vectors.h"
#include "tk_device.h"
#include "tk_fakes.h"
#include "tk_parser_vectors.h"
#include "tk_test.h"

#define SEQ 0x42

static tk_contacts_t book;
static tk_device_t dev;
static out_frame_t frames[256];
static size_t nframes;

static const tk_parser_vector_t *vec(const char *name) {
    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        if (strcmp(tk_parser_vectors[i].name, name) == 0) {
            return &tk_parser_vectors[i];
        }
    }
    fprintf(stderr, "no parser vector %s\n", name);
    abort();
}

static void setup(bool has_wallet, bool unlocked, bool with_alice) {
    fake_reset();
    fake_wallet_reset(has_wallet, unlocked);
    tk_contacts_init(&book);
    if (with_alice) {
        const tk_contacts_book_entry_t *a = &tk_contacts_book[0];
        TK_CHECK(tk_contacts_add(&book, (const uint8_t *)a->name, strlen(a->name), a->wallet) == TK_CONTACTS_OK);
    }
    tk_device_init(&dev, &FAKE_PLATFORM, &FAKE_WALLET, &book);
}

static void run(void) {
    tk_device_poll(&dev);
    nframes = fake_output(frames, sizeof(frames) / sizeof(frames[0]));
}

static void sign_request(const tk_parser_vector_t *v) {
    fake_send_now(TK_MSG_SIGN_REQUEST, SEQ, v->msg, v->msg_len);
}

// PIN 1 2 3 4 5 6 with every start digit 0 (the fake RNG returns 0).
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
        fake_press(TK_BTN_OK); // 0 0 0 0 0 0
    }
}

// The single reply to the SIGN_REQUEST (type 0x90, our seq); NULL unless exactly one exists.
static const out_frame_t *sign_reply(void) {
    const out_frame_t *found = NULL;
    int count = 0;
    for (size_t i = 0; i < nframes; i++) {
        if (frames[i].type == (TK_MSG_SIGN_REQUEST | TK_MSG_RESPONSE_BIT) && frames[i].seq == SEQ) {
            found = &frames[i];
            count++;
        }
    }
    return count == 1 ? found : NULL;
}

static int reply_status(void) {
    const out_frame_t *r = sign_reply();
    return r != NULL && r->len >= 1 ? r->payload[0] : -1;
}

static bool has_frame(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len) {
    for (size_t i = 0; i < nframes; i++) {
        if (frames[i].type == type && frames[i].seq == seq && frames[i].len == len &&
            (len == 0 || memcmp(frames[i].payload, payload, len) == 0)) {
            return true;
        }
    }
    return false;
}

static size_t clip_count(uint16_t clip) {
    size_t n = 0;
    for (size_t i = 0; i < fake_op_count; i++) {
        n += fake_ops[i].kind == OP_CLIP && fake_ops[i].value == clip;
    }
    return n;
}

static void collect_clips(uint16_t *out, size_t *n, size_t cap) {
    *n = 0;
    for (size_t i = 0; i < fake_op_count && *n < cap; i++) {
        if (fake_ops[i].kind == OP_CLIP) {
            out[(*n)++] = (uint16_t)fake_ops[i].value;
        }
    }
}

// sign may only follow a CONFIRM that came after "press confirm", while unlocked.
static void check_sign_invariant(void) {
    TK_CHECK(!fw.signed_while_locked);
    for (size_t i = 0; i < fake_op_count; i++) {
        if (fake_ops[i].kind != OP_SIGN) {
            continue;
        }
        int last_button = -1;
        size_t at = 0;
        for (size_t j = i; j-- > 0;) {
            if (fake_ops[j].kind == OP_BUTTON) {
                last_button = fake_ops[j].value;
                at = j;
                break;
            }
        }
        TK_CHECK(last_button == TK_BTN_CONFIRM);
        int last_clip = -1;
        for (size_t j = at; j-- > 0;) {
            if (fake_ops[j].kind == OP_CLIP) {
                last_clip = fake_ops[j].value;
                break;
            }
        }
        TK_CHECK(last_clip == TK_CLIP_PRESS_CONFIRM);
    }
}

static void check_signature(const tk_parser_vector_t *v) {
    const out_frame_t *r = sign_reply();
    TK_CHECK(r != NULL && r->len == 1 + TK_SIGNATURE_LEN && r->payload[0] == TK_STATUS_OK);
    if (r != NULL && r->len == 1 + TK_SIGNATURE_LEN) {
        TK_CHECK(ed25519_sign_open(v->msg, v->msg_len, v->device_pubkey, r->payload + 1) == 0);
    }
}

// ---- Tests ----

static void test_fake_wallet_is_vector_device(void) {
    setup(true, false, true);
    TK_CHECK_MEM(fw.pk, tk_parser_vectors[0].device_pubkey, 32);
}

static void test_happy_sol_locked(void) {
    const tk_parser_vector_t *v = vec("sol_ok");
    setup(true, false, true);
    sign_request(v);
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();

    check_signature(v);
    check_sign_invariant();
    TK_CHECK(fw.sign_calls == 1 && fw.unlock_calls == 1);

    // Exactly these frames, in this order (I2: nothing else is written).
    const uint8_t ev_ann = TK_EVENT_ANNOUNCING, ev_pin = TK_EVENT_AWAITING_PIN,
                  ev_conf = TK_EVENT_AWAITING_CONFIRM, ev_sign = TK_EVENT_SIGNING;
    TK_CHECK(nframes == 5);
    const uint8_t want_types[5] = {TK_MSG_EVENT, TK_MSG_EVENT, TK_MSG_EVENT, TK_MSG_EVENT,
                                   TK_MSG_SIGN_REQUEST | TK_MSG_RESPONSE_BIT};
    const uint8_t want_events[4] = {ev_ann, ev_pin, ev_conf, ev_sign};
    for (size_t i = 0; i < 5 && i < nframes; i++) {
        TK_CHECK(frames[i].type == want_types[i] && frames[i].seq == SEQ);
        if (i < 4) {
            TK_CHECK(frames[i].len == 1 && frames[i].payload[0] == want_events[i]);
        }
    }

    // "send zero point zero zero one five SOL to A L I C E checksum w w w", then PIN, confirm, signed.
    uint8_t ck[TK_TX_PHRASE_WORDS];
    tk_checksum_tx(v->msg, v->msg_len, ck);
    const uint16_t want[] = {TK_CLIP_SEND, TK_CLIP_ZERO, TK_CLIP_POINT, TK_CLIP_ZERO, TK_CLIP_ZERO,
                             TK_CLIP_ZERO + 1, TK_CLIP_ZERO + 5, TK_CLIP_SOL, TK_CLIP_TO,
                             TK_CLIP_LETTER_A + ('A' - 'A'), TK_CLIP_LETTER_A + ('L' - 'A'),
                             TK_CLIP_LETTER_A + ('I' - 'A'), TK_CLIP_LETTER_A + ('C' - 'A'),
                             TK_CLIP_LETTER_A + ('E' - 'A'), TK_CLIP_CHECKSUM, (uint16_t)(TK_CLIP_WORD_0 + ck[0]),
                             (uint16_t)(TK_CLIP_WORD_0 + ck[1]), (uint16_t)(TK_CLIP_WORD_0 + ck[2]),
                             TK_CLIP_ENTER_PIN};
    uint16_t clips[512];
    size_t n = 0;
    collect_clips(clips, &n, 512);
    const size_t wn = sizeof(want) / sizeof(want[0]);
    TK_CHECK(n > wn + 2);
    // I2: in the announcement only the three checksum words are secret.
    size_t secret_in_announcement = 0;
    for (size_t i = 0, k = 0; i < fake_op_count && k < wn - 1; i++) {
        if (fake_ops[i].kind == OP_CLIP) {
            const bool word = k >= wn - 4; // the last three before ENTER_PIN
            TK_CHECK(fake_ops[i].secret == word);
            secret_in_announcement += fake_ops[i].secret;
            k++;
        }
    }
    TK_CHECK(secret_in_announcement == 3);
    if (n > wn + 2) {
        TK_CHECK(memcmp(clips, want, sizeof(want)) == 0);
        TK_CHECK(clips[n - 2] == TK_CLIP_PRESS_CONFIRM && clips[n - 1] == TK_CLIP_SIGNED);
    }
}

static void test_happy_usdc_unlocked(void) {
    const tk_parser_vector_t *v = vec("usdc_ok");
    setup(true, true, true);
    sign_request(v);
    fake_press(TK_BTN_CONFIRM);
    run();
    check_signature(v);
    check_sign_invariant();
    TK_CHECK(fw.unlock_calls == 0);
    TK_CHECK(clip_count(TK_CLIP_ENTER_PIN) == 0 && clip_count(TK_CLIP_USDC) == 1);
    TK_CHECK(clip_count(TK_CLIP_ZERO + 2) >= 1 && clip_count(TK_CLIP_POINT) == 1); // "two point five"
    const uint8_t ev_pin = TK_EVENT_AWAITING_PIN;
    TK_CHECK(!has_frame(TK_MSG_EVENT, SEQ, &ev_pin, 1));
    TK_CHECK(nframes == 4);
}

static void test_refusals(void) {
    // Unknown recipient: Alice is not in the book.
    setup(true, false, false);
    sign_request(vec("sol_ok"));
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_UNKNOWN_RECIPIENT);
    TK_CHECK(fw.sign_calls == 0 && fw.unlock_calls == 0 && nframes == 1);
    TK_CHECK(clip_count(TK_CLIP_UNKNOWN_RECIPIENT) == 1 && clip_count(TK_CLIP_SEND) == 0);

    // Unsupported transaction.
    setup(true, true, true);
    sign_request(vec("usdc_wrong_mint"));
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_PARSE_UNSUPPORTED);
    TK_CHECK(fw.sign_calls == 0 && nframes == 1 && clip_count(TK_CLIP_CANNOT_SIGN) == 1);

    // No wallet.
    setup(false, false, true);
    sign_request(vec("sol_ok"));
    run();
    TK_CHECK(reply_status() == TK_STATUS_NO_WALLET);
    TK_CHECK(fw.sign_calls == 0 && fake_op_count == 1); // just the reply write

    // A payload larger than any message.
    setup(true, true, true);
    static uint8_t big[TK_MAX_MESSAGE_LEN + 1];
    fake_send_now(TK_MSG_SIGN_REQUEST, SEQ, big, sizeof(big));
    run();
    TK_CHECK(reply_status() == TK_STATUS_PARSE_UNSUPPORTED);
}

static void test_press_ahead_ignored(void) {
    // I6: CONFIRM pressed during the announcement is never seen; the window then times out.
    const tk_parser_vector_t *v = vec("sol_ok");
    setup(true, true, true);
    sign_request(v);
    fake_press_during_clip(TK_BTN_CONFIRM);
    fake_press_during_clip(TK_BTN_CONFIRM);
    run();
    TK_CHECK(fake.discarded_presses == 2);
    TK_CHECK(reply_status() == TK_STATUS_REJECTED_BY_USER);
    TK_CHECK(fw.sign_calls == 0);
    TK_CHECK(fake.now >= 1000 + TK_CONFIRM_TIMEOUT_MS);
}

static void test_confirm_window(void) {
    const tk_parser_vector_t *v = vec("sol_ok");

    setup(true, true, true);
    sign_request(v);
    fake_press(TK_BTN_REJECT);
    run();
    TK_CHECK(reply_status() == TK_STATUS_REJECTED_BY_USER && fw.sign_calls == 0);

    setup(true, true, true);
    sign_request(v);
    fake_press(TK_BTN_REJECT_LONG);
    run();
    TK_CHECK(reply_status() == TK_STATUS_CANCELLED && fw.sign_calls == 0);

    // Other buttons are ignored; 29 s pass; CONFIRM still in time.
    setup(true, true, true);
    sign_request(v);
    fake_press(TK_BTN_UP);
    fake_press(TK_BTN_OK);
    fake_advance(29000);
    fake_press(TK_BTN_CONFIRM);
    run();
    check_signature(v);

    // 31 s: too late.
    setup(true, true, true);
    sign_request(v);
    fake_advance(31000);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_REJECTED_BY_USER && fw.sign_calls == 0);

    // Long-press OK repeats the announcement and restarts the window.
    setup(true, true, true);
    sign_request(v);
    fake_advance(25000);
    fake_press(TK_BTN_OK_LONG);
    fake_advance(25000);
    fake_press(TK_BTN_CONFIRM);
    run();
    check_signature(v);
    check_sign_invariant();
    TK_CHECK(clip_count(TK_CLIP_SEND) == 2 && clip_count(TK_CLIP_PRESS_CONFIRM) == 2);
}

static void test_wrong_pin_and_lockout(void) {
    const tk_parser_vector_t *v = vec("sol_ok");
    setup(true, false, true);
    sign_request(v);
    script_wrong_pin();
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    check_signature(v);
    TK_CHECK(fw.unlock_calls == 2);
    TK_CHECK(clip_count(TK_CLIP_WRONG_PIN) == 1 && clip_count(TK_CLIP_ATTEMPTS_REMAINING) == 1);
    TK_CHECK(clip_count(TK_CLIP_ENTER_PIN) == 2);

    // Last attempt wrong: wallet wiped, contacts wiped and saved empty.
    setup(true, false, true);
    fw.attempts_left = 1;
    sign_request(v);
    script_wrong_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_LOCKED_OUT);
    TK_CHECK(fw.sign_calls == 0 && book.count == 0);
    TK_CHECK(clip_count(TK_CLIP_WALLET_WIPED) == 1);
    TK_CHECK(fake.stored_set && fake.stored_len == TK_CONTACTS_BLOB_LEN);
    tk_contacts_t reloaded;
    TK_CHECK(tk_contacts_load(&reloaded, fake.stored, fake.stored_len) == TK_CONTACTS_OK && reloaded.count == 0);
}

// The key store can't check a PIN (e.g. storage failed): DEVICE_ERROR, nothing signed (fail closed).
static void test_unlock_error(void) {
    const tk_parser_vector_t *v = vec("sol_ok");
    setup(true, false, true);
    fw.unlock_error = true;
    sign_request(v);
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_DEVICE_ERROR);
    TK_CHECK(fw.unlock_calls == 1 && fw.sign_calls == 0);
    TK_CHECK(clip_count(TK_CLIP_CANNOT_SIGN) == 1 && clip_count(TK_CLIP_PRESS_CONFIRM) == 0);
    TK_CHECK(book.count == 1); // not a lockout: nothing wiped
    check_sign_invariant();
}

// No working audio (no clip pack, I2S down): refuse before speaking anything (Q7).
static void test_no_audio(void) {
    const tk_parser_vector_t *v = vec("sol_ok");
    setup(true, true, true);
    fake.audio_bad = true;
    sign_request(v);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(reply_status() == TK_STATUS_DEVICE_ERROR);
    TK_CHECK(fw.sign_calls == 0);
    uint16_t clips[8];
    size_t n = 0;
    collect_clips(clips, &n, 8);
    TK_CHECK(n == 0);

    // No wallet still answers NO_WALLET first (nothing to protect yet).
    setup(false, false, true);
    fake.audio_bad = true;
    sign_request(v);
    run();
    TK_CHECK(reply_status() == TK_STATUS_NO_WALLET);
}

static void test_requests_during_flow(void) {
    const tk_parser_vector_t *v = vec("sol_ok");
    setup(true, true, true);
    sign_request(v);
    const uint8_t small[3] = {1, 2, 3};
    fake_frame(TK_MSG_GET_PUBKEY, 7, NULL, 0);
    fake_frame(TK_MSG_SIGN_REQUEST, 8, small, sizeof(small));
    fake_frame(TK_MSG_HELLO, 9, NULL, 0);
    fake_frame(TK_MSG_CONTACT_LIST_COUNT, 10, NULL, 0);
    fake_frame(0x55, 11, NULL, 0); // unknown type: still BUSY during a flow
    fake_frame(TK_MSG_CANCEL, 12, small, 1); // CANCEL with a payload: BAD_PAYLOAD, no cancel
    const uint8_t bad_version[] = {TK_FRAME_MAGIC, 0x02, TK_MSG_HELLO, 0x33, 0, 0};
    fake_raw_frame(bad_version, sizeof(bad_version));
    fake_press(TK_BTN_CONFIRM);
    run();
    check_signature(v);
    const uint8_t busy = TK_STATUS_BUSY, hello[4] = {1, 0, 1, TK_STATE_UNLOCKED};
    const uint8_t bad_payload = TK_PROTO_ERR_BAD_PAYLOAD, bad_frame = TK_PROTO_ERR_BAD_FRAME;
    TK_CHECK(has_frame(TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, 7, &busy, 1));
    TK_CHECK(has_frame(TK_MSG_SIGN_REQUEST | TK_MSG_RESPONSE_BIT, 8, &busy, 1));
    TK_CHECK(has_frame(TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, 9, hello, 4));
    TK_CHECK(has_frame(TK_MSG_CONTACT_LIST_COUNT | TK_MSG_RESPONSE_BIT, 10, &busy, 1));
    TK_CHECK(has_frame(0x55 | TK_MSG_RESPONSE_BIT, 11, &busy, 1));
    TK_CHECK(has_frame(TK_MSG_ERROR, 12, &bad_payload, 1));
    TK_CHECK(has_frame(TK_MSG_ERROR, 0x33, &bad_frame, 1));
    // The flow's own reply comes last.
    TK_CHECK(nframes > 0 && frames[nframes - 1].seq == SEQ);
}

static void test_cancel(void) {
    const uint8_t ok = TK_STATUS_OK;
    // During PIN entry.
    setup(true, false, true);
    sign_request(vec("sol_ok"));
    fake_press(TK_BTN_UP);
    fake_press(TK_BTN_OK);
    fake_frame(TK_MSG_CANCEL, 20, NULL, 0);
    script_correct_pin();
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(has_frame(TK_MSG_CANCEL | TK_MSG_RESPONSE_BIT, 20, &ok, 1));
    TK_CHECK(reply_status() == TK_STATUS_CANCELLED);
    TK_CHECK(fw.sign_calls == 0 && fw.unlock_calls == 0);

    // During the confirm window.
    setup(true, true, true);
    sign_request(vec("usdc_ok"));
    fake_advance(1000);
    fake_frame(TK_MSG_CANCEL, 21, NULL, 0);
    fake_press(TK_BTN_CONFIRM);
    run();
    TK_CHECK(has_frame(TK_MSG_CANCEL | TK_MSG_RESPONSE_BIT, 21, &ok, 1));
    TK_CHECK(reply_status() == TK_STATUS_CANCELLED && fw.sign_calls == 0);

    // During the announcement: the rest of it is not spoken.
    setup(true, true, true);
    sign_request(vec("sol_ok"));
    fake_frame(TK_MSG_CANCEL, 22, NULL, 0);
    run();
    TK_CHECK(reply_status() == TK_STATUS_CANCELLED && fw.sign_calls == 0);
    TK_CHECK(clip_count(TK_CLIP_CHECKSUM) == 0 && clip_count(TK_CLIP_CANCELLED) == 1);

    // With no flow running.
    setup(true, true, true);
    fake_send_now(TK_MSG_CANCEL, 23, NULL, 0);
    run();
    TK_CHECK(nframes == 1 && has_frame(TK_MSG_CANCEL | TK_MSG_RESPONSE_BIT, 23, &ok, 1));
}

static void test_idle_requests(void) {
    setup(true, false, true);
    fake_send_now(TK_MSG_HELLO, 1, NULL, 0);
    fake_send_now(TK_MSG_GET_PUBKEY, 2, NULL, 0);
    fake_send_now(TK_MSG_CONTACT_LIST_COUNT, 3, NULL, 0);
    fake_send_now(TK_MSG_SETUP, 4, NULL, 0);
    fake_send_now(TK_MSG_CONTACT_ADD, 5, NULL, 0);
    fake_send_now(TK_MSG_HELLO, 6, (const uint8_t *)"x", 1);
    fake_send_now(0x7D, 7, NULL, 0);
    run();
    const uint8_t hello[4] = {1, 0, 1, TK_STATE_LOCKED};
    uint8_t pub[33];
    pub[0] = TK_STATUS_OK;
    memcpy(pub + 1, fw.pk, 32);
    const uint8_t one = 1, unknown = TK_PROTO_ERR_UNKNOWN_TYPE, bad_payload = TK_PROTO_ERR_BAD_PAYLOAD;
    TK_CHECK(nframes == 7);
    TK_CHECK(has_frame(TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, 1, hello, 4));
    TK_CHECK(has_frame(TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, 2, pub, 33));
    TK_CHECK(has_frame(TK_MSG_CONTACT_LIST_COUNT | TK_MSG_RESPONSE_BIT, 3, &one, 1));
    TK_CHECK(has_frame(TK_MSG_ERROR, 4, &unknown, 1));
    TK_CHECK(has_frame(TK_MSG_ERROR, 5, &unknown, 1));
    TK_CHECK(has_frame(TK_MSG_ERROR, 6, &bad_payload, 1));
    TK_CHECK(has_frame(TK_MSG_ERROR, 7, &unknown, 1));

    setup(false, false, true);
    fake_send_now(TK_MSG_HELLO, 1, NULL, 0);
    fake_send_now(TK_MSG_GET_PUBKEY, 2, NULL, 0);
    run();
    const uint8_t hello0[4] = {1, 0, 1, TK_STATE_NO_WALLET}, no_wallet = TK_STATUS_NO_WALLET;
    TK_CHECK(has_frame(TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, 1, hello0, 4));
    TK_CHECK(has_frame(TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, 2, &no_wallet, 1));
}

static uint32_t rs = 0x5EED1234u;
static uint32_t rnd(void) {
    rs ^= rs << 13;
    rs ^= rs >> 17;
    rs ^= rs << 5;
    return rs;
}

static void test_random_scripts(void) {
    static const char *const names[] = {"sol_ok", "usdc_ok", "usdc_ok_zero", "sol_ok_u64_max", "usdc_wrong_mint"};
    static const tk_button_t buttons[] = {TK_BTN_UP, TK_BTN_DOWN, TK_BTN_OK, TK_BTN_BACK, TK_BTN_CONFIRM,
                                          TK_BTN_REJECT, TK_BTN_OK_LONG, TK_BTN_REJECT_LONG};
    int signed_ok = 0;
    for (int iter = 0; iter < TK_TEST_ITERS(10000); iter++) {
        const tk_parser_vector_t *v = vec(names[rnd() % 5]);
        setup(true, rnd() % 2, rnd() % 8 != 0);
        fw.attempts_left = 1 + (int)(rnd() % 3);
        fake.rng_len = 8;
        for (size_t i = 0; i < 8; i++) {
            fake.rng[i] = (uint8_t)rnd();
        }
        sign_request(v);
        const int steps = (int)(rnd() % 60);
        for (int s = 0; s < steps; s++) {
            const uint32_t k = rnd() % 20;
            if (k < 11) {
                fake_press(buttons[rnd() % 8]);
            } else if (k < 13) {
                fake_press_during_clip(buttons[rnd() % 8]);
            } else if (k < 14) {
                fake_advance(rnd() % 40000);
            } else if (k < 15) {
                fake_frame(TK_MSG_CANCEL, (uint8_t)(rnd() | 0x80), NULL, 0);
            } else if (k < 17) {
                const uint8_t types[] = {TK_MSG_HELLO, TK_MSG_GET_PUBKEY, TK_MSG_SIGN_REQUEST, TK_MSG_SETUP};
                fake_frame(types[rnd() % 4], (uint8_t)(rnd() | 0x80), NULL, 0);
            } else {
                uint8_t junk[24];
                for (size_t b = 0; b < sizeof(junk); b++) {
                    junk[b] = (uint8_t)rnd();
                }
                junk[0] = TK_FRAME_MAGIC;
                fake_raw_frame(junk, sizeof(junk));
            }
        }
        run();
        const out_frame_t *r = sign_reply();
        if (r == NULL) {
            fprintf(stderr, "random script %d: not exactly one SIGN_REQUEST reply\n", iter);
        }
        TK_CHECK(r != NULL);
        check_sign_invariant();
        TK_CHECK(fw.sign_calls <= 1);
        if (r != NULL && r->payload[0] == TK_STATUS_OK) {
            check_signature(v);
            TK_CHECK(fw.sign_calls == 1);
            signed_ok++;
        } else {
            TK_CHECK(r == NULL || r->len == 1);
        }
        if (tk_test_failures > 0) {
            fprintf(stderr, "random script %d failed\n", iter);
            break;
        }
    }
    TK_CHECK(signed_ok > 0); // some random scripts do reach a signature
}

int main(void) {
    test_fake_wallet_is_vector_device();
    test_happy_sol_locked();
    test_happy_usdc_unlocked();
    test_refusals();
    test_press_ahead_ignored();
    test_confirm_window();
    test_wrong_pin_and_lockout();
    test_unlock_error();
    test_no_audio();
    test_requests_during_flow();
    test_cancel();
    test_idle_requests();
    test_random_scripts();
    return tk_test_result();
}
