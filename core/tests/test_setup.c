// SETUP flow (core/src/tk_setup.c), driven through the fake platform: happy path (fake wallet and
// the real key store), the words the user hears really recover the stored key, I10/I2 refusals,
// cancels in every phase, PIN mismatches, timeouts, and press timing mixed into the entropy.

#include <stdlib.h>

#include "ed25519.h"
#include "tk_device.h"
#include "tk_fakes.h"
#include "tk_keystore.h"
#include "tk_seed.h"
#include "tk_test.h"

#define SEQ 0x33

static tk_contacts_t book;
static tk_device_t dev;
static out_frame_t frames[64];
static size_t nframes;
static tk_keystore_t ks;
static tk_wallet_ops_t ks_ops;

static const uint8_t PIN[TK_PIN_LEN] = {1, 2, 3, 4, 5, 6};

static void setup_fake(bool has_wallet) {
    fake_reset();
    fake_wallet_reset(has_wallet, false);
    tk_contacts_init(&book);
    tk_device_init(&dev, &FAKE_PLATFORM, &FAKE_WALLET, &book);
}

static void setup_keystore(void) {
    fake_reset();
    tk_contacts_init(&book);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ks_ops);
    tk_device_init(&dev, &FAKE_PLATFORM, &ks_ops, &book);
}

static void run(void) {
    tk_device_poll(&dev);
    nframes = fake_output(frames, sizeof(frames) / sizeof(frames[0]));
}

static void send_setup(void) {
    fake_send_now(TK_MSG_SETUP, SEQ, NULL, 0);
}

// PIN 1 2 3 4 5 6 with every start digit 0 (the fake RNG returns 0).
static void script_pin(void) {
    for (int d = 1; d <= 6; d++) {
        for (int i = 0; i < d; i++) {
            fake_press(TK_BTN_UP);
        }
        fake_press(TK_BTN_OK);
    }
}

static void script_other_pin(void) {
    for (int d = 0; d < 6; d++) {
        fake_press(TK_BTN_OK); // 0 0 0 0 0 0
    }
}

static void script_words(int oks) {
    for (int i = 0; i < oks; i++) {
        fake_press(TK_BTN_OK);
    }
}

static void script_happy(void) {
    script_pin();
    script_pin();
    script_words(TK_SEED_WORDS + 1); // 24 words, then OK at "press OK to finish"
}

// The SETUP reply's status, -1 unless exactly one reply with our seq.
static int setup_status(void) {
    int st = -1, count = 0;
    for (size_t i = 0; i < nframes; i++) {
        if (frames[i].type == (TK_MSG_SETUP | TK_MSG_RESPONSE_BIT) && frames[i].seq == SEQ) {
            st = frames[i].len == 1 ? frames[i].payload[0] : -2;
            count++;
        }
    }
    return count == 1 ? st : -1;
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

static size_t count_ops(op_kind_t kind, int value) {
    size_t n = 0;
    for (size_t i = 0; i < fake_op_count; i++) {
        n += fake_ops[i].kind == kind && (value < 0 || fake_ops[i].value == value);
    }
    return n;
}

static bool is_letter(int clip) {
    return clip >= TK_CLIP_LETTER_A && clip < TK_CLIP_LETTER_A + 26;
}

// Rebuild the 24 word indices from what was spoken after each RECOVERY_WORD (first pass only):
// exactly what a listener could write down.
static bool heard_words(uint16_t idx[TK_SEED_WORDS]) {
    size_t w = 0;
    for (size_t i = 0; i < fake_op_count && w < TK_SEED_WORDS; i++) {
        if (fake_ops[i].kind != OP_CLIP || fake_ops[i].value != TK_CLIP_RECOVERY_WORD) {
            continue;
        }
        char heard[9] = {0}; // BIP39 English words have 3..8 letters, all spelled
        size_t n = 0;
        for (size_t j = i + 1; j < fake_op_count && fake_ops[j].kind == OP_CLIP; j++) {
            if (fake_ops[j].secret) {
                if (!is_letter(fake_ops[j].value) || n == 8) {
                    return false;
                }
                heard[n++] = (char)('a' + (fake_ops[j].value - TK_CLIP_LETTER_A));
            } else if (n > 0) {
                break; // letters are done
            }
        }
        int found = -1;
        for (uint16_t k = 0; k < TK_SEED_WORD_COUNT; k++) {
            if (strcmp(tk_seed_word(k), heard) == 0) { // the whole word, exactly
                found = k;
            }
        }
        if (found < 0) {
            return false;
        }
        idx[w++] = (uint16_t)found;
    }
    return w == TK_SEED_WORDS;
}

static void check_happy_shape(void) {
    TK_CHECK(setup_status() == TK_STATUS_OK);
    const uint8_t ev = TK_EVENT_AWAITING_PIN;
    TK_CHECK(has_frame(TK_MSG_EVENT, SEQ, &ev, 1));
    TK_CHECK(nframes == 2); // the event and the reply: nothing else crosses the link (I2)
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_RECOVERY_WORD) == TK_SEED_WORDS);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_WRITE_DOWN) == 1);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_NEXT_WORD_HELP) == 1);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_CHOOSE_PIN) == 1 && count_ops(OP_CLIP, TK_CLIP_ENTER_PIN_AGAIN) == 1);
    TK_CHECK(count_ops(OP_HAPTIC, TK_HAPTIC_SUCCESS) == 1);

    // Order: CHOOSE_PIN first; after the PIN: PLEASE_WAIT, WRITE_DOWN, RECOVERY_WORD, ONE, letters,
    // NEXT_WORD_HELP, RECOVERY_WORD, TWO ...; at the end REPLAY_ALL, PLEASE_WAIT, WALLET_CREATED.
    uint16_t clips[600];
    size_t n = 0;
    for (size_t i = 0; i < fake_op_count && n < 600; i++) {
        if (fake_ops[i].kind == OP_CLIP) {
            clips[n++] = (uint16_t)fake_ops[i].value;
        }
    }
    TK_CHECK(n > 10 && clips[0] == TK_CLIP_CHOOSE_PIN);
    size_t at = 0;
    while (at < n && clips[at] != TK_CLIP_WRITE_DOWN) {
        at++;
    }
    TK_CHECK(at > 0 && at + 4 < n && clips[at - 1] == TK_CLIP_PLEASE_WAIT);
    if (at + 4 < n) {
        TK_CHECK(clips[at + 1] == TK_CLIP_RECOVERY_WORD && clips[at + 2] == TK_CLIP_ZERO + 1);
        size_t k = at + 3;
        while (k < n && is_letter(clips[k])) {
            k++;
        }
        TK_CHECK(k - (at + 3) >= 3 && k - (at + 3) <= 8); // the whole word
        TK_CHECK(k + 2 < n && clips[k] == TK_CLIP_NEXT_WORD_HELP && clips[k + 1] == TK_CLIP_RECOVERY_WORD &&
                 clips[k + 2] == TK_CLIP_ZERO + 2);
    }
    TK_CHECK(clips[n - 3] == TK_CLIP_REPLAY_ALL && clips[n - 2] == TK_CLIP_PLEASE_WAIT &&
             clips[n - 1] == TK_CLIP_WALLET_CREATED);

    // Word k's position is one clip, then its first letter: 1-19 "one".."nineteen", 20 "twenty",
    // 21-24 the single "twenty one".."twenty four" clips (two clips ran into the letters).
    unsigned k = 0;
    for (size_t i = 0; i + 2 < n; i++) {
        if (clips[i] != TK_CLIP_RECOVERY_WORD) {
            continue;
        }
        k++;
        const unsigned want = k < 20 ? TK_CLIP_ZERO + k : k == 20 ? TK_CLIP_TWENTY : TK_CLIP_TWENTY_ONE + (k - 21);
        TK_CHECK(clips[i + 1] == want);
        TK_CHECK(is_letter(clips[i + 2]));
    }
    TK_CHECK(k == TK_SEED_WORDS);

    // I2: after the PIN, the only secret clips are recovery letters; every letter there is secret.
    bool after_pin = false;
    for (size_t i = 0; i < fake_op_count; i++) {
        if (fake_ops[i].kind != OP_CLIP) {
            continue;
        }
        if (fake_ops[i].value == TK_CLIP_WRITE_DOWN) {
            after_pin = true;
        }
        if (after_pin) {
            TK_CHECK(fake_ops[i].secret == is_letter(fake_ops[i].value));
        }
    }
}

static void test_happy_fake_wallet(void) {
    setup_fake(false);
    send_setup();
    script_happy();
    run();
    check_happy_shape();
    TK_CHECK(fw.create_calls == 1);
    TK_CHECK_MEM(fw.created_pin, PIN, TK_PIN_LEN);
    // HELLO now: unlocked (state 2); GET_PUBKEY returns the new key.
    fake_send_now(TK_MSG_HELLO, 1, NULL, 0);
    fake_send_now(TK_MSG_GET_PUBKEY, 2, NULL, 0);
    run();
    const uint8_t hello[4] = {TK_FW_VERSION & 0xFF, TK_FW_VERSION >> 8, TK_PROTO_VERSION, TK_STATE_UNLOCKED};
    TK_CHECK(has_frame(TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, 1, hello, sizeof(hello)));
    uint8_t want[33];
    want[0] = TK_STATUS_OK;
    memcpy(want + 1, fw.pk, 32);
    TK_CHECK(has_frame(TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, 2, want, sizeof(want)));
}

// End to end with the real key store: the words the user heard recover the key that was stored.
static void test_happy_keystore(void) {
    setup_keystore();
    send_setup();
    script_happy();
    run();
    check_happy_shape();

    uint8_t blob[TK_KEYSTORE_BLOB_LEN + 1];
    size_t len = sizeof(blob);
    TK_CHECK(FAKE_PLATFORM.storage_get(NULL, TK_STORAGE_WALLET, blob, &len) && len == TK_KEYSTORE_BLOB_LEN);
    uint8_t sk[32];
    TK_CHECK(tk_keystore_open(blob, len, PIN, sk) == TK_KEYSTORE_OPEN_OK);

    uint16_t idx[TK_SEED_WORDS];
    TK_CHECK(heard_words(idx));
    uint8_t seed[TK_SEED_LEN], key[32];
    TK_CHECK(tk_seed_bip39(idx, "", seed));
    TK_CHECK(tk_slip10_ed25519(seed, sizeof(seed), TK_SOLANA_PATH, TK_SOLANA_PATH_LEN, key));
    TK_CHECK_MEM(key, sk, 32); // the spoken words are the wallet
    TK_CHECK(ks_ops.is_unlocked(ks_ops.ctx));

    // Second SETUP: refused at once, silent (I10).
    const size_t ops_before = fake_op_count;
    fake_send_now(TK_MSG_SETUP, 5, NULL, 0);
    run();
    const uint8_t exists = TK_STATUS_WALLET_EXISTS;
    TK_CHECK(has_frame(TK_MSG_SETUP | TK_MSG_RESPONSE_BIT, 5, &exists, 1));
    bool any_audio = false;
    for (size_t i = ops_before; i < fake_op_count; i++) {
        any_audio = any_audio || fake_ops[i].kind == OP_CLIP || fake_ops[i].kind == OP_HAPTIC;
    }
    TK_CHECK(!any_audio);
}

static void test_refusals(void) {
    // Wallet exists: WALLET_EXISTS, nothing played, create never called (I10).
    setup_fake(true);
    send_setup();
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_WALLET_EXISTS);
    TK_CHECK(count_ops(OP_CLIP, -1) == 0 && count_ops(OP_HAPTIC, -1) == 0 && fw.create_calls == 0);

    // Payload not empty.
    setup_fake(false);
    const uint8_t junk = 1;
    fake_send_now(TK_MSG_SETUP, SEQ, &junk, 1);
    run();
    const uint8_t bad = TK_PROTO_ERR_BAD_PAYLOAD;
    TK_CHECK(has_frame(TK_MSG_ERROR, SEQ, &bad, 1) && count_ops(OP_CLIP, -1) == 0);

    // No audio: refused, silent.
    setup_fake(false);
    fake.audio_bad = true;
    send_setup();
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_DEVICE_ERROR);
    TK_CHECK(count_ops(OP_CLIP, -1) == 0 && fw.create_calls == 0);

    // RNG fails in PIN entry, and (separately) at generation (calls 1-12 are the 12 start digits).
    setup_fake(false);
    fake.rng_fail = true;
    send_setup();
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_DEVICE_ERROR && fw.create_calls == 0);
    setup_fake(false);
    fake.rng_fail_from = 13;
    send_setup();
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_DEVICE_ERROR && fw.create_calls == 0);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_RECOVERY_WORD) == 0);

    // The key store fails to store it: DEVICE_ERROR, still no wallet, and SETUP may run again.
    setup_fake(false);
    fw.fail_create = true;
    send_setup();
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_DEVICE_ERROR && fw.create_calls == 1 && !fw.has_wallet);
    fw.fail_create = false;
    fake.cursor = fake.step_count = 0;
    fake_op_count = 0;
    fake.tx_len = 0;
    fake_send_now(TK_MSG_SETUP, SEQ, NULL, 0);
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_OK && fw.has_wallet);

    // The real key store over failing storage: DEVICE_ERROR, nothing stored.
    setup_keystore();
    fake.fail_set_key = TK_STORAGE_WALLET;
    send_setup();
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_DEVICE_ERROR && !ks_ops.has_wallet(ks_ops.ctx));
}

static void test_pin_mismatch(void) {
    // One mismatch, then a match: OK.
    setup_fake(false);
    send_setup();
    script_pin();
    script_other_pin();
    script_pin();
    script_pin();
    script_words(TK_SEED_WORDS + 1);
    run();
    TK_CHECK(setup_status() == TK_STATUS_OK);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_PINS_DONT_MATCH) == 1 && count_ops(OP_HAPTIC, TK_HAPTIC_WARNING) == 1);
    TK_CHECK_MEM(fw.created_pin, PIN, TK_PIN_LEN);

    // Three mismatches: CANCELLED, no wallet.
    setup_fake(false);
    send_setup();
    for (int i = 0; i < 3; i++) {
        script_pin();
        script_other_pin();
    }
    script_words(TK_SEED_WORDS + 1);
    run();
    TK_CHECK(setup_status() == TK_STATUS_CANCELLED && fw.create_calls == 0);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_PINS_DONT_MATCH) == 2);
}

static void cancel_frame(void) {
    fake_frame(TK_MSG_CANCEL, 0x70, NULL, 0);
}

static void expect_cancelled(void) {
    TK_CHECK(setup_status() == TK_STATUS_CANCELLED);
    const uint8_t ok = TK_STATUS_OK;
    TK_CHECK(has_frame(TK_MSG_CANCEL | TK_MSG_RESPONSE_BIT, 0x70, &ok, 1));
    TK_CHECK(fw.create_calls == 0 && !fw.has_wallet);
    TK_CHECK(count_ops(OP_HAPTIC, TK_HAPTIC_REJECT) == 1);
}

static void test_cancel(void) {
    // Host CANCEL during the first PIN entry.
    setup_fake(false);
    send_setup();
    fake_press(TK_BTN_UP);
    fake_press(TK_BTN_OK);
    cancel_frame();
    script_happy();
    run();
    expect_cancelled();
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_RECOVERY_WORD) == 0);

    // At word 13.
    setup_fake(false);
    send_setup();
    script_pin();
    script_pin();
    script_words(12);
    cancel_frame();
    script_words(13);
    run();
    expect_cancelled();
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_RECOVERY_WORD) == 13);

    // At the final "press OK to finish".
    setup_fake(false);
    send_setup();
    script_pin();
    script_pin();
    script_words(TK_SEED_WORDS);
    cancel_frame();
    script_words(1);
    run();
    expect_cancelled();

    // Long REJECT at a word: CANCELLED. Short REJECT: REJECTED_BY_USER.
    setup_fake(false);
    send_setup();
    script_pin();
    script_pin();
    script_words(3);
    fake_press(TK_BTN_REJECT_LONG);
    run();
    TK_CHECK(setup_status() == TK_STATUS_CANCELLED && fw.create_calls == 0);
    setup_fake(false);
    send_setup();
    script_pin();
    script_pin();
    script_words(3);
    fake_press(TK_BTN_REJECT);
    run();
    TK_CHECK(setup_status() == TK_STATUS_REJECTED_BY_USER && fw.create_calls == 0);

    // REJECT during PIN entry.
    setup_fake(false);
    send_setup();
    fake_press(TK_BTN_REJECT);
    run();
    TK_CHECK(setup_status() == TK_STATUS_REJECTED_BY_USER && fw.create_calls == 0);

    // Nobody presses anything at word 5: 300 s later, CANCELLED.
    setup_fake(false);
    send_setup();
    script_pin();
    script_pin();
    script_words(4);
    const uint32_t t0 = fake.now;
    run();
    TK_CHECK(setup_status() == TK_STATUS_CANCELLED && fw.create_calls == 0);
    TK_CHECK(fake.now - t0 >= TK_SETUP_WORD_TIMEOUT_MS);
}

static void test_navigation(void) {
    // BACK at word 1 repeats word 1; UP/DOWN/CONFIRM at a word do nothing; OK_LONG repeats a word;
    // OK_LONG at the end replays from word 1.
    setup_fake(false);
    send_setup();
    script_pin();
    script_pin();
    fake_press(TK_BTN_BACK);    // word 1 again
    fake_press(TK_BTN_UP);      // ignored
    fake_press(TK_BTN_CONFIRM); // ignored
    fake_press(TK_BTN_OK_LONG); // word 1 again
    script_words(TK_SEED_WORDS); // words 1..24 done, at the final prompt
    fake_press(TK_BTN_BACK);    // word 24 again
    fake_press(TK_BTN_OK);      // final prompt again
    fake_press(TK_BTN_OK_LONG); // all 24 again
    script_words(TK_SEED_WORDS + 1);
    run();
    TK_CHECK(setup_status() == TK_STATUS_OK);
    // 3 x word 1 + 24 + word 24 again + 24 again = 51.
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_RECOVERY_WORD) == 51);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_REPLAY_ALL) == 3);
    TK_CHECK(count_ops(OP_CLIP, TK_CLIP_NEXT_WORD_HELP) == 1);
}

static void test_requests_during_setup(void) {
    setup_fake(false);
    send_setup();
    fake_press(TK_BTN_UP);
    fake_frame(TK_MSG_HELLO, 0x50, NULL, 0);
    fake_frame(TK_MSG_GET_PUBKEY, 0x51, NULL, 0);
    fake_frame(TK_MSG_SIGN_REQUEST, 0x52, NULL, 0);
    fake_press(TK_BTN_REJECT_LONG); // end it: the replies above are what this test is about
    run();
    TK_CHECK(setup_status() == TK_STATUS_CANCELLED);
    const uint8_t hello[4] = {TK_FW_VERSION & 0xFF, TK_FW_VERSION >> 8, TK_PROTO_VERSION, TK_STATE_NO_WALLET};
    TK_CHECK(has_frame(TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, 0x50, hello, sizeof(hello)));
    const uint8_t busy = TK_STATUS_BUSY;
    TK_CHECK(has_frame(TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, 0x51, &busy, 1));
    TK_CHECK(has_frame(TK_MSG_SIGN_REQUEST | TK_MSG_RESPONSE_BIT, 0x52, &busy, 1));
}

// Same RNG, different press timing: a different wallet. Same timing: the same wallet.
static void run_for_pubkey(uint32_t pause_ms, uint8_t pk[32]) {
    setup_fake(false);
    send_setup();
    if (pause_ms > 0) {
        fake_advance(pause_ms); // the user waits before the first press
    }
    script_happy();
    run();
    TK_CHECK(setup_status() == TK_STATUS_OK);
    memcpy(pk, fw.pk, 32);
}

static void test_timing_mixed_in(void) {
    uint8_t a[32], b[32], c[32];
    run_for_pubkey(0, a);
    run_for_pubkey(0, b);
    run_for_pubkey(500, c);
    TK_CHECK_MEM(a, b, 32);
    TK_CHECK(memcmp(a, c, 32) != 0);
}

int main(void) {
    test_happy_fake_wallet();
    test_happy_keystore();
    test_refusals();
    test_pin_mismatch();
    test_cancel();
    test_navigation();
    test_requests_during_setup();
    test_timing_mixed_in();
    return tk_test_result();
}
