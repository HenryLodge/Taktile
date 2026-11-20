// The expected hex below came from a second, independent base58 decoder (not tools/gen-consts.mjs),
// so a bug in the generator can't pass its own test.

#include "tk_solana_consts.h"
#include "tk_test.h"

int main(void) {
    uint8_t expect[TK_PUBKEY_LEN];

    const uint8_t zero[TK_PUBKEY_LEN] = {0};
    TK_CHECK_MEM(TK_SYSTEM_PROGRAM_ID, zero, TK_PUBKEY_LEN);

    tk_hex("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9", expect, sizeof(expect));
    TK_CHECK_MEM(TK_TOKEN_PROGRAM_ID, expect, TK_PUBKEY_LEN);

    tk_hex("8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859", expect, sizeof(expect));
    TK_CHECK_MEM(TK_ATA_PROGRAM_ID, expect, TK_PUBKEY_LEN);

    tk_hex("3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7", expect, sizeof(expect));
    TK_CHECK_MEM(TK_DEVNET_USDC_MINT, expect, TK_PUBKEY_LEN);

    // Staking IDs and the pinned validator (hex from web3.js PublicKey, a different decoder).
    tk_hex("06a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000", expect, sizeof(expect));
    TK_CHECK_MEM(TK_STAKE_PROGRAM_ID, expect, TK_PUBKEY_LEN);
    tk_hex("06a1d817a502050b680791e6ce6db88e1e5b7150f61fc6790a4eb4d100000000", expect, sizeof(expect));
    TK_CHECK_MEM(TK_STAKE_CONFIG_ID, expect, TK_PUBKEY_LEN);
    tk_hex("06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000", expect, sizeof(expect));
    TK_CHECK_MEM(TK_SYSVAR_RENT_ID, expect, TK_PUBKEY_LEN);
    tk_hex("06a7d51718c774c928566398691d5eb68b5eb8a39b4b6d5c73555b2100000000", expect, sizeof(expect));
    TK_CHECK_MEM(TK_SYSVAR_CLOCK_ID, expect, TK_PUBKEY_LEN);
    tk_hex("06a7d517193584d0feed9bb3431d13206be544281b57b8566cc5375ff4000000", expect, sizeof(expect));
    TK_CHECK_MEM(TK_SYSVAR_STAKE_HISTORY_ID, expect, TK_PUBKEY_LEN);
    tk_hex("ddf42a04800a54de2e583f94f17b089725b772d1333526271241532776d2ffc6", expect, sizeof(expect));
    TK_CHECK_MEM(TK_VALIDATOR_VOTE, expect, TK_PUBKEY_LEN); // tools/validator.json: Kiln
    TK_CHECK(TK_STAKE_SPACE == 200u && TK_STAKE_SEEDS == 16u);

    TK_CHECK(TK_USDC_DECIMALS == 6u);
    TK_CHECK(sizeof(TK_SYSTEM_PROGRAM_ID) == 32u);

    const uint8_t *ids[] = {TK_SYSTEM_PROGRAM_ID, TK_TOKEN_PROGRAM_ID, TK_ATA_PROGRAM_ID,
                            TK_DEVNET_USDC_MINT, TK_STAKE_PROGRAM_ID, TK_STAKE_CONFIG_ID,
                            TK_SYSVAR_RENT_ID, TK_SYSVAR_CLOCK_ID, TK_SYSVAR_STAKE_HISTORY_ID,
                            TK_VALIDATOR_VOTE};
    const size_t n = sizeof(ids) / sizeof(ids[0]);
    for (size_t i = 0; i < n; i++) {
        for (size_t j = i + 1; j < n; j++) {
            TK_CHECK(memcmp(ids[i], ids[j], TK_PUBKEY_LEN) != 0);
        }
    }

    return tk_test_result();
}
