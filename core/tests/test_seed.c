// tk_seed: BIP39 (published trezor vectors), SLIP-10 Ed25519 (published SLIP-0010 vectors), the
// Solana path end to end (web3.js public keys), entropy mixing, and refusals.

#include <string.h>

#include "ed25519.h"
#include "tk_seed.h"
#include "tk_seed_vectors.h"
#include "tk_test.h"

static void test_bip39_vectors(void) {
    for (size_t i = 0; i < TK_BIP39_VECTOR_COUNT; i++) {
        const tk_bip39_vector_t *v = &tk_bip39_vectors[i];
        uint16_t idx[TK_SEED_WORDS];
        TK_CHECK(tk_seed_words(v->entropy, idx));
        TK_CHECK_MEM(idx, v->indices, sizeof(idx));

        char m[TK_SEED_MNEMONIC_MAX];
        const size_t n = tk_seed_mnemonic(idx, m, sizeof(m));
        TK_CHECK(n == strlen(v->mnemonic));
        TK_CHECK(strcmp(m, v->mnemonic) == 0);

        uint8_t seed[TK_SEED_LEN];
        TK_CHECK(tk_seed_bip39(idx, v->passphrase, seed));
        TK_CHECK_MEM(seed, v->seed, sizeof(seed));
    }
}

static void test_slip10_vectors(void) {
    for (size_t i = 0; i < TK_SLIP10_VECTOR_COUNT; i++) {
        const tk_slip10_vector_t *v = &tk_slip10_vectors[i];
        uint8_t seed[64];
        const size_t seed_len = strlen(v->seed_hex) / 2;
        TK_CHECK(seed_len <= sizeof(seed));
        tk_hex(v->seed_hex, seed, seed_len);
        uint8_t key[TK_SEED_KEY_LEN];
        TK_CHECK(tk_slip10_ed25519(seed, seed_len, v->path, v->path_len, key));
        TK_CHECK_MEM(key, v->key, sizeof(key));
        ed25519_public_key pub;
        ed25519_publickey(key, pub);
        TK_CHECK_MEM(pub, v->pubkey, sizeof(pub));
    }
}

static void test_solana_path(void) {
    TK_CHECK(TK_SOLANA_PATH[0] == (44u | TK_SLIP10_HARDENED));
    TK_CHECK(TK_SOLANA_PATH[1] == (501u | TK_SLIP10_HARDENED));
    TK_CHECK(TK_SOLANA_PATH[2] == TK_SLIP10_HARDENED);
    TK_CHECK(TK_SOLANA_PATH[3] == TK_SLIP10_HARDENED);
    // Same mnemonics as the BIP39 vectors, without a passphrase: what SETUP derives.
    TK_CHECK(TK_SOLANA_SEED_VECTOR_COUNT == TK_BIP39_VECTOR_COUNT);
    for (size_t i = 0; i < TK_SOLANA_SEED_VECTOR_COUNT && i < TK_BIP39_VECTOR_COUNT; i++) {
        const tk_solana_seed_vector_t *v = &tk_solana_seed_vectors[i];
        TK_CHECK(strcmp(v->mnemonic, tk_bip39_vectors[i].mnemonic) == 0);
        uint8_t seed[TK_SEED_LEN], key[TK_SEED_KEY_LEN];
        TK_CHECK(tk_seed_bip39(tk_bip39_vectors[i].indices, "", seed));
        TK_CHECK(tk_slip10_ed25519(seed, sizeof(seed), TK_SOLANA_PATH, TK_SOLANA_PATH_LEN, key));
        TK_CHECK_MEM(key, v->key, sizeof(key));
        ed25519_public_key pub;
        ed25519_publickey(key, pub);
        TK_CHECK_MEM(pub, v->pubkey, sizeof(pub));
    }
}

static void test_wordlist(void) {
    TK_CHECK(strcmp(tk_seed_word(0), "abandon") == 0);
    TK_CHECK(strcmp(tk_seed_word(2047), "zoo") == 0);
    TK_CHECK(tk_seed_word(2048) == NULL);
    TK_CHECK(tk_seed_word(UINT16_MAX) == NULL);
    // AUDIO.md spells recovery words by their first 4 letters: those must identify every word.
    for (uint16_t a = 0; a < TK_SEED_WORD_COUNT; a++) {
        const size_t la = strlen(tk_seed_word(a));
        TK_CHECK(la >= 3 && la <= 8);
        if ((unsigned)a + 1u < TK_SEED_WORD_COUNT) {
            TK_CHECK(strncmp(tk_seed_word(a), tk_seed_word((uint16_t)(a + 1)), 4) != 0); // sorted list
        }
        for (const char *c = tk_seed_word(a); *c; c++) {
            TK_CHECK(*c >= 'a' && *c <= 'z'); // spellable with the letter clips
        }
    }
}

static void test_mix(void) {
    uint8_t hw[32], t1[32], t2[32], a[32], b[32], c[32];
    memset(hw, 0x11, sizeof(hw));
    memset(t1, 0x22, sizeof(t1));
    memcpy(t2, t1, sizeof(t2));
    t2[31] ^= 1;
    tk_seed_mix_entropy(hw, t1, a);
    tk_seed_mix_entropy(hw, t1, b);
    tk_seed_mix_entropy(hw, t2, c);
    TK_CHECK_MEM(a, b, sizeof(a));          // deterministic
    TK_CHECK(memcmp(a, c, sizeof(a)) != 0); // timing changes the entropy
    TK_CHECK(memcmp(a, hw, sizeof(a)) != 0);
}

static void test_refusals(void) {
    uint8_t ent[32] = {0}, seed[64] = {0}, key[32];
    uint16_t idx[TK_SEED_WORDS] = {0};
    char m[TK_SEED_MNEMONIC_MAX];

    TK_CHECK(!tk_seed_words(NULL, idx));
    TK_CHECK(!tk_seed_words(ent, NULL));

    TK_CHECK(tk_seed_mnemonic(NULL, m, sizeof(m)) == 0);
    TK_CHECK(tk_seed_mnemonic(idx, NULL, sizeof(m)) == 0);
    TK_CHECK(tk_seed_mnemonic(idx, m, sizeof(m) - 1) == 0); // cap below the worst case
    idx[23] = 2048;
    TK_CHECK(tk_seed_mnemonic(idx, m, sizeof(m)) == 0);
    TK_CHECK(!tk_seed_bip39(idx, "", seed)); // bad index
    idx[23] = 0;
    TK_CHECK(!tk_seed_bip39(NULL, "", seed));
    TK_CHECK(!tk_seed_bip39(idx, NULL, seed));
    TK_CHECK(!tk_seed_bip39(idx, "", NULL));

    // Non-hardened index: refused, key zeroed.
    const uint32_t soft[2] = {44u | TK_SLIP10_HARDENED, 0u};
    memset(key, 0xAA, sizeof(key));
    TK_CHECK(!tk_slip10_ed25519(seed, sizeof(seed), soft, 2, key));
    const uint8_t zero[32] = {0};
    TK_CHECK_MEM(key, zero, sizeof(key));
    TK_CHECK(!tk_slip10_ed25519(NULL, 64, TK_SOLANA_PATH, 4, key));
    TK_CHECK(!tk_slip10_ed25519(seed, 0, TK_SOLANA_PATH, 4, key));
    TK_CHECK(!tk_slip10_ed25519(seed, 64, NULL, 4, key));
    TK_CHECK(!tk_slip10_ed25519(seed, 64, TK_SOLANA_PATH, 4, NULL));
    TK_CHECK(tk_slip10_ed25519(seed, 64, NULL, 0, key)); // empty path = master key
}

int main(void) {
    test_bip39_vectors();
    test_slip10_vectors();
    test_solana_path();
    test_wordlist();
    test_mix();
    test_refusals();
    return tk_test_result();
}
