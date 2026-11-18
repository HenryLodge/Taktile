// tk_keystore: blob seal/open, create (write order, failures, I10 refusals), init of good, empty and
// corrupt blobs, signing only while unlocked, and unlock failing closed until the PIN-unlock task.

#include "tk_keystore.h"

#include "ed25519.h"
#include "sha2.h"
#include "tk_fakes.h"
#include "tk_test.h"

static const uint8_t PIN[TK_PIN_LEN] = {1, 2, 3, 4, 5, 6};
static const uint8_t OTHER_PIN[TK_PIN_LEN] = {1, 2, 3, 4, 5, 7};
static uint8_t sk[32], pk[32];

static tk_keystore_t ks;
static tk_wallet_ops_t ops;

static void keys(void) {
    const char *label = "taktile-vector:device"; // public test key (never funded)
    sha256_Raw((const uint8_t *)label, strlen(label), sk);
    ed25519_publickey(sk, pk);
}

static void fresh(void) {
    fake_reset();
    for (size_t i = 0; i < 16; i++) {
        fake.rng[i] = (uint8_t)(0xA0 + i);
    }
    fake.rng_len = 16;
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ops);
}

static bool stored(const char *key, uint8_t *buf, size_t *len) {
    return FAKE_PLATFORM.storage_get(NULL, key, buf, len);
}

static bool is_zero(const uint8_t *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (b[i] != 0) {
            return false;
        }
    }
    return true;
}

static void test_seal_open(void) {
    uint8_t salt[TK_KEYSTORE_SALT_LEN], blob[TK_KEYSTORE_BLOB_LEN], out[32];
    memset(salt, 0x5A, sizeof(salt));
    TK_CHECK(tk_keystore_seal(PIN, sk, pk, salt, TK_KDF_ITERS_MIN, blob));
    TK_CHECK(memcmp(blob, "TKW1", 4) == 0 && blob[4] == 1);
    TK_CHECK(blob[5] == (TK_KDF_ITERS_MIN & 0xFF) && blob[6] == (TK_KDF_ITERS_MIN >> 8) && blob[7] == 0 && blob[8] == 0);
    TK_CHECK_MEM(blob + 9, salt, sizeof(salt));
    TK_CHECK_MEM(blob + 25, pk, 32);
    TK_CHECK(memcmp(blob + 57, sk, 32) != 0); // the key is not stored in the clear

    TK_CHECK(tk_keystore_open(blob, sizeof(blob), PIN, out) == TK_KEYSTORE_OPEN_OK);
    TK_CHECK_MEM(out, sk, 32);

    // Wrong PIN: tag mismatch, key zeroed.
    memset(out, 0xEE, sizeof(out));
    TK_CHECK(tk_keystore_open(blob, sizeof(blob), OTHER_PIN, out) == TK_KEYSTORE_OPEN_WRONG_PIN);
    TK_CHECK(is_zero(out, sizeof(out)));

    // Every single bit flip in salt, pubkey, ct or tag is caught; header flips are BAD_BLOB or
    // WRONG_PIN (the tag covers the iteration count too). Never OK.
    for (size_t byte = 0; byte < TK_KEYSTORE_BLOB_LEN; byte += 3) {
        uint8_t t[TK_KEYSTORE_BLOB_LEN];
        memcpy(t, blob, sizeof(t));
        t[byte] ^= 0x01;
        const tk_keystore_open_t r = tk_keystore_open(t, sizeof(t), PIN, out);
        TK_CHECK(r != TK_KEYSTORE_OPEN_OK);
        TK_CHECK(is_zero(out, sizeof(out)));
    }

    // Different salt, same key and PIN: different ciphertext.
    uint8_t blob2[TK_KEYSTORE_BLOB_LEN];
    salt[0] ^= 1;
    TK_CHECK(tk_keystore_seal(PIN, sk, pk, salt, TK_KDF_ITERS_MIN, blob2));
    TK_CHECK(memcmp(blob + 57, blob2 + 57, 32) != 0);

    // A tag that is valid but for a key that doesn't match pubkey: BAD_BLOB.
    uint8_t other_pk[32];
    memcpy(other_pk, pk, 32);
    other_pk[0] ^= 1;
    TK_CHECK(tk_keystore_seal(PIN, sk, other_pk, salt, TK_KDF_ITERS_MIN, blob2));
    TK_CHECK(tk_keystore_open(blob2, sizeof(blob2), PIN, out) == TK_KEYSTORE_OPEN_BAD_BLOB);
    TK_CHECK(is_zero(out, sizeof(out)));

    // Refusals.
    const uint8_t bad_pin[TK_PIN_LEN] = {1, 2, 3, 4, 5, 10};
    TK_CHECK(!tk_keystore_seal(bad_pin, sk, pk, salt, TK_KDF_ITERS_MIN, blob2));
    TK_CHECK(!tk_keystore_seal(PIN, sk, pk, salt, TK_KDF_ITERS_MIN - 1, blob2));
    TK_CHECK(!tk_keystore_seal(PIN, sk, pk, salt, TK_KDF_ITERS_MAX + 1, blob2));
    TK_CHECK(!tk_keystore_seal(NULL, sk, pk, salt, TK_KDF_ITERS_MIN, blob2));
    TK_CHECK(tk_keystore_open(blob, sizeof(blob) - 1, PIN, out) == TK_KEYSTORE_OPEN_BAD_BLOB);
    TK_CHECK(tk_keystore_open(NULL, sizeof(blob), PIN, out) == TK_KEYSTORE_OPEN_BAD_BLOB);
    TK_CHECK(tk_keystore_open(blob, sizeof(blob), bad_pin, out) == TK_KEYSTORE_OPEN_BAD_BLOB);
}

static void test_create_and_reload(void) {
    fresh();
    TK_CHECK(!ops.has_wallet(ops.ctx));
    uint8_t got[32];
    TK_CHECK(!ops.get_pubkey(ops.ctx, got));

    TK_CHECK(ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(ops.has_wallet(ops.ctx) && ops.is_unlocked(ops.ctx));
    TK_CHECK(ops.get_pubkey(ops.ctx, got));
    TK_CHECK_MEM(got, pk, 32);

    // Write order: the counter before the wallet.
    TK_CHECK(fake.set_count == 2);
    TK_CHECK(strcmp(fake.set_log[0], TK_STORAGE_PIN_FAILS) == 0);
    TK_CHECK(strcmp(fake.set_log[1], TK_STORAGE_WALLET) == 0);
    uint8_t buf[200];
    size_t len = sizeof(buf);
    TK_CHECK(stored(TK_STORAGE_PIN_FAILS, buf, &len) && len == 1 && buf[0] == 0);
    len = sizeof(buf);
    TK_CHECK(stored(TK_STORAGE_WALLET, buf, &len) && len == TK_KEYSTORE_BLOB_LEN);
    TK_CHECK(buf[5] == (TK_KDF_ITERS & 0xFF) && buf[6] == ((TK_KDF_ITERS >> 8) & 0xFF)); // 20000
    TK_CHECK_MEM(buf + 9, fake.rng, TK_KEYSTORE_SALT_LEN); // salt from the RNG
    uint8_t out[32];
    TK_CHECK(tk_keystore_open(buf, len, PIN, out) == TK_KEYSTORE_OPEN_OK);
    TK_CHECK_MEM(out, sk, 32);

    // Signs while unlocked; the signature verifies.
    const uint8_t msg[] = "taktile";
    uint8_t sig[TK_SIGNATURE_LEN];
    TK_CHECK(ops.sign(ops.ctx, msg, sizeof(msg), sig));
    TK_CHECK(ed25519_sign_open(msg, sizeof(msg), pk, sig) == 0);
    // One unlock, one signature: locked again, key gone from RAM.
    TK_CHECK(!ops.is_unlocked(ops.ctx) && is_zero(ks.sk, sizeof(ks.sk)));
    TK_CHECK(!ops.sign(ops.ctx, msg, sizeof(msg), sig));

    // Second create: refused, nothing written (I10).
    fake.set_count = 0;
    TK_CHECK(!ops.create(ops.ctx, OTHER_PIN, sk, pk));
    TK_CHECK(fake.set_count == 0);

    // Locked: no signature.
    tk_keystore_lock(&ks);
    TK_CHECK(!ops.is_unlocked(ops.ctx));
    TK_CHECK(is_zero(ks.sk, sizeof(ks.sk)));
    TK_CHECK(!ops.sign(ops.ctx, msg, sizeof(msg), sig));

    // Reboot: same wallet, locked, pubkey available, create still refused.
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ops);
    TK_CHECK(ks.state == TK_KEYSTORE_READY && ops.has_wallet(ops.ctx) && !ops.is_unlocked(ops.ctx));
    TK_CHECK(ops.get_pubkey(ops.ctx, got));
    TK_CHECK_MEM(got, pk, 32);
    TK_CHECK(!ops.sign(ops.ctx, msg, sizeof(msg), sig));
    fake.set_count = 0;
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(fake.set_count == 0);

    // The right PIN after the reboot (full 20,000 iterations): unlocked, and it can sign once.
    uint8_t left = 0xFF;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_OK && ops.is_unlocked(ops.ctx));
    TK_CHECK(ops.sign(ops.ctx, msg, sizeof(msg), sig) && ed25519_sign_open(msg, sizeof(msg), pk, sig) == 0);
    TK_CHECK(!ops.is_unlocked(ops.ctx));
}

// ---- Unlock, counter, wipe, auto-lock (wallets sealed at TK_KDF_ITERS_MIN: fast on the device) ----

static uint8_t stored_fails(void) {
    uint8_t v = 0xEE;
    size_t len = 1;
    return stored(TK_STORAGE_PIN_FAILS, &v, &len) && len == 1 ? v : 0xEE;
}

static size_t stored_wallet_len(void) {
    uint8_t buf[TK_KEYSTORE_BLOB_LEN + 1];
    size_t len = sizeof(buf);
    return stored(TK_STORAGE_WALLET, buf, &len) ? len : 9999;
}

static void put_wallet(uint8_t fails) {
    uint8_t salt[TK_KEYSTORE_SALT_LEN] = {7};
    uint8_t blob[TK_KEYSTORE_BLOB_LEN];
    TK_CHECK(tk_keystore_seal(PIN, sk, pk, salt, TK_KDF_ITERS_MIN, blob));
    fake_kv_put(TK_STORAGE_WALLET, blob, sizeof(blob));
    fake_kv_put(TK_STORAGE_PIN_FAILS, &fails, 1);
}

// A stored wallet (PIN 123456) with pin-fails = fails, then a "boot" (init).
static void install(uint8_t fails) {
    fresh();
    put_wallet(fails);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ops);
    fake.set_count = 0;
}

static void test_unlock(void) {
    uint8_t left = 0;
    install(0);
    TK_CHECK(ks.state == TK_KEYSTORE_READY && !ops.is_unlocked(ops.ctx));

    // Wrong: counted, 9 left, still locked.
    TK_CHECK(ops.unlock(ops.ctx, OTHER_PIN, &left) == TK_UNLOCK_WRONG && left == 9);
    TK_CHECK(stored_fails() == 1 && !ops.is_unlocked(ops.ctx) && is_zero(ks.sk, sizeof(ks.sk)));
    TK_CHECK(ops.unlock(ops.ctx, OTHER_PIN, &left) == TK_UNLOCK_WRONG && left == 8 && stored_fails() == 2);

    // Right: unlocked, counter back to 0; the count is written first, then the reset.
    fake.set_count = 0;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_OK && ops.is_unlocked(ops.ctx));
    TK_CHECK(stored_fails() == 0);
    TK_CHECK(fake.set_count == 2 && strcmp(fake.set_log[0], TK_STORAGE_PIN_FAILS) == 0 &&
             strcmp(fake.set_log[1], TK_STORAGE_PIN_FAILS) == 0);
    TK_CHECK_MEM(ks.sk, sk, 32);

    // Unlocking again while unlocked is harmless (and also counted first).
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_OK && stored_fails() == 0);

    // The lock op (USB host lost) ends the session.
    ops.lock(ops.ctx);
    TK_CHECK(!ops.is_unlocked(ops.ctx) && is_zero(ks.sk, sizeof(ks.sk)));
    const uint8_t msg[] = "x";
    uint8_t sig[TK_SIGNATURE_LEN];
    TK_CHECK(!ops.sign(ops.ctx, msg, sizeof(msg), sig));
}

static void test_counter_before_check(void) {
    uint8_t left = 0;
    // The counter can't be written: even the RIGHT PIN is not checked (I7).
    install(0);
    fake.fail_set_key = TK_STORAGE_PIN_FAILS;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_ERROR);
    TK_CHECK(!ops.is_unlocked(ops.ctx) && is_zero(ks.sk, sizeof(ks.sk)));
    TK_CHECK(stored_fails() == 0 && stored_wallet_len() == TK_KEYSTORE_BLOB_LEN); // nothing wiped

    // The counter can't be read (missing value, or the wrong size): ERROR, nothing written or wiped.
    install(0);
    fake_kv_put(TK_STORAGE_PIN_FAILS, NULL, 0);
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_ERROR && fake.set_count == 0);
    const uint8_t two[2] = {0, 0};
    fake_kv_put(TK_STORAGE_PIN_FAILS, two, 2);
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_ERROR && fake.set_count == 0);
    TK_CHECK(stored_wallet_len() == TK_KEYSTORE_BLOB_LEN && !ops.is_unlocked(ops.ctx));

    // Power cut right after the count is written (no later write lands): the next boot still sees
    // the attempt, even though the PIN was right.
    install(3);
    fake.fail_set_after = 1;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_OK); // its reset write was "lost"
    TK_CHECK(stored_fails() == 4);
    fake.fail_set_after = 0;
    tk_keystore_init(&ks, &FAKE_PLATFORM); // reboot
    tk_keystore_ops(&ks, &ops);
    TK_CHECK(!ops.is_unlocked(ops.ctx));
    TK_CHECK(ops.unlock(ops.ctx, OTHER_PIN, &left) == TK_UNLOCK_WRONG && left == 5); // 4 + 1 counted
}

static void test_wipe(void) {
    uint8_t left = 0;
    // The 10th wrong PIN in a row wipes: count, wallet, then the counter reset.
    install(9);
    TK_CHECK(ops.unlock(ops.ctx, OTHER_PIN, &left) == TK_UNLOCK_LOCKED_OUT);
    TK_CHECK(ks.state == TK_KEYSTORE_EMPTY && !ops.has_wallet(ops.ctx) && is_zero(ks.sk, sizeof(ks.sk)));
    TK_CHECK(is_zero(ks.pubkey, sizeof(ks.pubkey)) && is_zero(ks.blob, sizeof(ks.blob)));
    TK_CHECK(stored_wallet_len() == 0 && stored_fails() == 0);
    TK_CHECK(fake.set_count == 3 && strcmp(fake.set_log[0], TK_STORAGE_PIN_FAILS) == 0 &&
             strcmp(fake.set_log[1], TK_STORAGE_WALLET) == 0 && strcmp(fake.set_log[2], TK_STORAGE_PIN_FAILS) == 0);
    // No wallet now: a new one can be created (I10's documented exception).
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_LOCKED_OUT);
    TK_CHECK(ops.create(ops.ctx, PIN, sk, pk));

    // Ten in a row from zero.
    install(0);
    tk_unlock_result_t r = TK_UNLOCK_WRONG;
    for (unsigned i = 1; i <= TK_PIN_MAX_FAILS; i++) {
        r = ops.unlock(ops.ctx, OTHER_PIN, &left);
        TK_CHECK(i < TK_PIN_MAX_FAILS ? (r == TK_UNLOCK_WRONG && left == TK_PIN_MAX_FAILS - i)
                                      : r == TK_UNLOCK_LOCKED_OUT);
    }
    TK_CHECK(r == TK_UNLOCK_LOCKED_OUT && !ops.has_wallet(ops.ctx) && stored_wallet_len() == 0);

    // Already at the limit (a wipe cut short after boot): wiped even with the right PIN, unchecked.
    install(9);
    const uint8_t ten = TK_PIN_MAX_FAILS;
    fake_kv_put(TK_STORAGE_PIN_FAILS, &ten, 1);
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_LOCKED_OUT && !ops.has_wallet(ops.ctx));

    // The wallet can't be cleared: CORRUPT, never unlocks, can't be replaced.
    install(9);
    fake.fail_set_key = TK_STORAGE_WALLET;
    TK_CHECK(ops.unlock(ops.ctx, OTHER_PIN, &left) == TK_UNLOCK_LOCKED_OUT);
    TK_CHECK(ks.state == TK_KEYSTORE_CORRUPT && ops.has_wallet(ops.ctx));
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_ERROR && !ops.create(ops.ctx, PIN, sk, pk));
}

static void test_resume_wipe(void) {
    // Boot with the counter at the limit and the wallet still stored: init finishes the wipe.
    fresh();
    put_wallet(TK_PIN_MAX_FAILS);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    TK_CHECK(ks.state == TK_KEYSTORE_EMPTY && stored_wallet_len() == 0 && stored_fails() == 0);

    // Same, but the wallet write fails: CORRUPT (fail closed), never EMPTY.
    fresh();
    put_wallet(TK_PIN_MAX_FAILS);
    fake.fail_set_key = TK_STORAGE_WALLET;
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    TK_CHECK(ks.state == TK_KEYSTORE_CORRUPT);

    // Below the limit: nothing happens at boot.
    fresh();
    put_wallet(TK_PIN_MAX_FAILS - 1);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    TK_CHECK(ks.state == TK_KEYSTORE_READY && fake.set_count == 0);
}

static void test_autolock(void) {
    uint8_t left = 0;
    install(0);
    fake.now = 1000;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_OK);
    fake.now = 1000 + TK_AUTOLOCK_MS - 1;
    TK_CHECK(ops.is_unlocked(ops.ctx));
    fake.now = 1000 + TK_AUTOLOCK_MS;
    TK_CHECK(!ops.is_unlocked(ops.ctx) && is_zero(ks.sk, sizeof(ks.sk)));
    const uint8_t msg[] = "x";
    uint8_t sig[TK_SIGNATURE_LEN];
    TK_CHECK(!ops.sign(ops.ctx, msg, sizeof(msg), sig));

    // Across the 32-bit millisecond wrap (after ~49.7 days up).
    fake.now = UINT32_MAX - 1000;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_OK);
    fake.now = 5000; // wrapped: 6001 ms later
    TK_CHECK(ops.is_unlocked(ops.ctx));
    fake.now = (uint32_t)(UINT32_MAX - 1000 + TK_AUTOLOCK_MS);
    TK_CHECK(!ops.is_unlocked(ops.ctx));

    // create starts a session too (SETUP leaves the device unlocked), with the same limit.
    fresh();
    fake.now = 50;
    TK_CHECK(ops.create(ops.ctx, PIN, sk, pk) && ops.is_unlocked(ops.ctx));
    fake.now = 50 + TK_AUTOLOCK_MS;
    TK_CHECK(!ops.is_unlocked(ops.ctx));

    // EMPTY never touches storage when asked to unlock.
    fresh();
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_LOCKED_OUT && fake.set_count == 0);
}

static void test_create_failures(void) {
    // Counter write fails: no wallet written, still empty, RAM clean.
    fresh();
    fake.fail_set_key = TK_STORAGE_PIN_FAILS;
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(fake.set_count == 1 && strcmp(fake.set_log[0], TK_STORAGE_PIN_FAILS) == 0);
    TK_CHECK(!ops.has_wallet(ops.ctx) && !ops.is_unlocked(ops.ctx));
    TK_CHECK(is_zero(ks.sk, sizeof(ks.sk)));
    uint8_t buf[200];
    size_t len = sizeof(buf);
    TK_CHECK(!stored(TK_STORAGE_WALLET, buf, &len));

    // Wallet write fails: still empty; the cleanup write is tried (and fails here too).
    fresh();
    fake.fail_set_key = TK_STORAGE_WALLET;
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(!ops.has_wallet(ops.ctx));
    TK_CHECK(is_zero(ks.sk, sizeof(ks.sk)));
    TK_CHECK(fake.set_count == 3 && strcmp(fake.set_log[2], TK_STORAGE_WALLET) == 0);

    // Read-back differs from what was written: refused, and the written blob is cleared.
    fresh();
    fake.flip_get_key = TK_STORAGE_WALLET;
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(!ops.has_wallet(ops.ctx) && !ops.is_unlocked(ops.ctx));
    TK_CHECK(fake.set_count == 3 && strcmp(fake.set_log[2], TK_STORAGE_WALLET) == 0);
    fake.flip_get_key = NULL;
    len = sizeof(buf);
    TK_CHECK(stored(TK_STORAGE_WALLET, buf, &len) && len == 0);

    // Storage off entirely (NVS didn't open): refused.
    fresh();
    fake.storage_off = true;
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(!ops.has_wallet(ops.ctx));

    // RNG fails: refused before any write.
    fresh();
    fake.rng_fail = true;
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(fake.set_count == 0 && !ops.has_wallet(ops.ctx));

    // Bad PIN digit or NULL arguments: refused before any write.
    fresh();
    const uint8_t bad_pin[TK_PIN_LEN] = {0, 0, 0, 0, 0, 255};
    TK_CHECK(!ops.create(ops.ctx, bad_pin, sk, pk));
    TK_CHECK(!ops.create(ops.ctx, PIN, NULL, pk));
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, NULL));
    TK_CHECK(fake.set_count == 0 && !ops.has_wallet(ops.ctx));
}

static void expect_corrupt(const uint8_t *blob, size_t len) {
    fresh();
    fake_kv_put(TK_STORAGE_WALLET, blob, len);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    tk_keystore_ops(&ks, &ops);
    TK_CHECK(ks.state == TK_KEYSTORE_CORRUPT);
    TK_CHECK(ops.has_wallet(ops.ctx)); // counts as a wallet: SETUP must refuse (I10)
    uint8_t got[32];
    TK_CHECK(!ops.get_pubkey(ops.ctx, got));
    TK_CHECK(!ops.is_unlocked(ops.ctx));
    uint8_t left = 0;
    TK_CHECK(ops.unlock(ops.ctx, PIN, &left) == TK_UNLOCK_ERROR);
    TK_CHECK(!ops.create(ops.ctx, PIN, sk, pk));
    TK_CHECK(fake.set_count == 0);
}

static void test_init_corrupt(void) {
    uint8_t salt[TK_KEYSTORE_SALT_LEN] = {0};
    uint8_t good[TK_KEYSTORE_BLOB_LEN + 1];
    TK_CHECK(tk_keystore_seal(PIN, sk, pk, salt, TK_KDF_ITERS_MIN, good));
    good[TK_KEYSTORE_BLOB_LEN] = 0;
    uint8_t t[TK_KEYSTORE_BLOB_LEN + 1];

    expect_corrupt(good, TK_KEYSTORE_BLOB_LEN - 1); // truncated
    expect_corrupt(good, 1);
    expect_corrupt(good, TK_KEYSTORE_BLOB_LEN + 1); // one byte too long
    memcpy(t, good, sizeof(t));
    t[0] = 'X'; // magic
    expect_corrupt(t, TK_KEYSTORE_BLOB_LEN);
    memcpy(t, good, sizeof(t));
    t[4] = 2; // version
    expect_corrupt(t, TK_KEYSTORE_BLOB_LEN);
    memcpy(t, good, sizeof(t));
    memset(t + 5, 0, 4); // 0 iterations
    expect_corrupt(t, TK_KEYSTORE_BLOB_LEN);
    memcpy(t, good, sizeof(t));
    t[5] = 0x80; // 2,000,000 iterations
    t[6] = 0x84;
    t[7] = 0x1E;
    t[8] = 0;
    expect_corrupt(t, TK_KEYSTORE_BLOB_LEN);

    // Zero length (how a wipe will clear it): no wallet.
    fresh();
    fake_kv_put(TK_STORAGE_WALLET, NULL, 0);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    TK_CHECK(ks.state == TK_KEYSTORE_EMPTY);

    // A well-formed blob loads (its tag is only checked at unlock).
    fresh();
    fake_kv_put(TK_STORAGE_WALLET, good, TK_KEYSTORE_BLOB_LEN);
    tk_keystore_init(&ks, &FAKE_PLATFORM);
    TK_CHECK(ks.state == TK_KEYSTORE_READY && !ks.unlocked);
    TK_CHECK_MEM(ks.pubkey, pk, 32);
}

int main(void) {
    keys();
    test_seal_open();
    test_create_and_reload();
    test_create_failures();
    test_init_corrupt();
    test_unlock();
    test_counter_before_check();
    test_wipe();
    test_resume_wipe();
    test_autolock();
    return tk_test_result();
}
