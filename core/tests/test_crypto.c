// Smoke tests for the vendored trezor-crypto subset, using published test vectors.
// These prove the host build of the library is wired up correctly; they are not
// a substitute for upstream's own test suite.

#include <string.h>

#include "bip39.h"
#include "ed25519.h"
#include "hmac.h"
#include "pbkdf2.h"
#include "sha2.h"
#include "tk_test.h"

static void test_sha2(void) {
    const uint8_t abc[] = {'a', 'b', 'c'};
    uint8_t out256[SHA256_DIGEST_LENGTH];
    uint8_t out512[SHA512_DIGEST_LENGTH];
    uint8_t want256[SHA256_DIGEST_LENGTH];
    uint8_t want512[SHA512_DIGEST_LENGTH];

    // FIPS 180-2 "abc"
    sha256_Raw(abc, sizeof(abc), out256);
    tk_hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", want256, sizeof(want256));
    TK_CHECK_MEM(out256, want256, sizeof(want256));

    sha512_Raw(abc, sizeof(abc), out512);
    tk_hex("ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
           "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
           want512, sizeof(want512));
    TK_CHECK_MEM(out512, want512, sizeof(want512));
}

static void test_hmac(void) {
    // RFC 4231 test case 1: key = 20 x 0x0b, data = "Hi There"
    uint8_t key[20];
    memset(key, 0x0b, sizeof(key));
    const char *msg = "Hi There";
    uint8_t out256[SHA256_DIGEST_LENGTH];
    uint8_t out512[SHA512_DIGEST_LENGTH];
    uint8_t want256[SHA256_DIGEST_LENGTH];
    uint8_t want512[SHA512_DIGEST_LENGTH];

    hmac_sha256(key, sizeof(key), (const uint8_t *)msg, (uint32_t)strlen(msg), out256);
    tk_hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7", want256, sizeof(want256));
    TK_CHECK_MEM(out256, want256, sizeof(want256));

    // HMAC-SHA512 is what SLIP-10 uses.
    hmac_sha512(key, sizeof(key), (const uint8_t *)msg, (uint32_t)strlen(msg), out512);
    tk_hex("87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde"
           "daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854",
           want512, sizeof(want512));
    TK_CHECK_MEM(out512, want512, sizeof(want512));
}

static void test_pbkdf2(void) {
    // PBKDF2-HMAC-SHA256, P = "password", S = "salt", dkLen = 32
    const uint8_t pass[] = {'p', 'a', 's', 's', 'w', 'o', 'r', 'd'};
    const uint8_t salt[] = {'s', 'a', 'l', 't'};
    uint8_t out[32];
    uint8_t want[32];

    pbkdf2_hmac_sha256(pass, sizeof(pass), salt, sizeof(salt), 1, out, sizeof(out));
    tk_hex("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b", want, sizeof(want));
    TK_CHECK_MEM(out, want, sizeof(want));

    pbkdf2_hmac_sha256(pass, sizeof(pass), salt, sizeof(salt), 4096, out, sizeof(out));
    tk_hex("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a", want, sizeof(want));
    TK_CHECK_MEM(out, want, sizeof(want));
}

static void test_ed25519(void) {
    ed25519_secret_key sk;
    ed25519_public_key pk;
    ed25519_public_key want_pk;
    ed25519_signature sig;
    ed25519_signature want_sig;

    // RFC 8032 section 7.1, TEST 1 (empty message)
    tk_hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", sk, sizeof(sk));
    tk_hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", want_pk, sizeof(want_pk));
    tk_hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
           "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
           want_sig, sizeof(want_sig));
    ed25519_publickey(sk, pk);
    TK_CHECK_MEM(pk, want_pk, sizeof(pk));
    ed25519_sign(NULL, 0, sk, sig);
    TK_CHECK_MEM(sig, want_sig, sizeof(sig));
    TK_CHECK(ed25519_sign_open(NULL, 0, pk, sig) == 0);

    // RFC 8032 section 7.1, TEST 2 (one-byte message 0x72)
    const uint8_t msg[1] = {0x72};
    tk_hex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", sk, sizeof(sk));
    tk_hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", want_pk, sizeof(want_pk));
    tk_hex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
           "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
           want_sig, sizeof(want_sig));
    ed25519_publickey(sk, pk);
    TK_CHECK_MEM(pk, want_pk, sizeof(pk));
    ed25519_sign(msg, sizeof(msg), sk, sig);
    TK_CHECK_MEM(sig, want_sig, sizeof(sig));
    TK_CHECK(ed25519_sign_open(msg, sizeof(msg), pk, sig) == 0);

    // A tampered message or signature must not verify.
    const uint8_t other[1] = {0x73};
    TK_CHECK(ed25519_sign_open(other, sizeof(other), pk, sig) != 0);
    sig[0] ^= 0x01;
    TK_CHECK(ed25519_sign_open(msg, sizeof(msg), pk, sig) != 0);
}

static void test_bip39(void) {
    // Trezor's published BIP39 vector: 16 zero bytes of entropy, passphrase "TREZOR".
    const uint8_t entropy[16] = {0};
    const char *want_mnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    uint8_t seed[64];
    uint8_t want_seed[64];

    const char *mnemonic = mnemonic_from_data(entropy, sizeof(entropy));
    TK_CHECK(mnemonic != NULL);
    if (mnemonic != NULL) {
        TK_CHECK(strcmp(mnemonic, want_mnemonic) == 0);
        TK_CHECK(mnemonic_check(mnemonic) == 1);
    }

    mnemonic_to_seed(want_mnemonic, "TREZOR", seed, NULL);
    tk_hex("c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
           "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
           want_seed, sizeof(want_seed));
    TK_CHECK_MEM(seed, want_seed, sizeof(seed));

    // Bad checksum word must be rejected.
    TK_CHECK(mnemonic_check("abandon abandon abandon abandon abandon abandon abandon abandon "
                            "abandon abandon abandon abandon") == 0);

    mnemonic_clear();
}

int main(void) {
    test_sha2();
    test_hmac();
    test_pbkdf2();
    test_ed25519();
    test_bip39();
    return tk_test_result();
}
