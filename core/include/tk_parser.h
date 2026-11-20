// Solana legacy message parser: accepts exactly the shapes in docs/SOLANA.md (A: SOL transfer, B: USDC
// TransferChecked, C: stake with the pinned validator, D: unstake), rejects all else.
//
// Untrusted input. Every read is bounds-checked; no allocation, no recursion.

#ifndef TK_PARSER_H
#define TK_PARSER_H

#include <stddef.h>
#include <stdint.h>

#include "tk_proto.h"
#include "tk_solana_consts.h"

#define TK_MAX_MESSAGE_LEN 1232u

typedef enum {
    TK_TX_SOL = 1,  // Shape A: System Program Transfer
    TK_TX_USDC = 2, // Shape B: SPL Token TransferChecked, devnet USDC
    TK_TX_STAKE = 3,   // Shape C: CreateAccountWithSeed + Initialize + DelegateStake (pinned validator)
    TK_TX_UNSTAKE = 4, // Shape D: Deactivate one of the device's own stake accounts
} tk_tx_kind_t;

typedef struct {
    tk_tx_kind_t kind;
    uint64_t amount;                      // lamports, or USDC base units (6 decimals). Stake: lamports
                                          // funded (rent reserve included). Unstake: 0.
    uint8_t destination[TK_PUBKEY_LEN];   // SOL: recipient wallet. USDC: recipient token account.
                                          // Stake/unstake: the device's own stake account.
    uint8_t stake_index;                  // Stake/unstake: n in seed "tk-stake-<n>" (0-15); else 0
} tk_tx_t;

// Why a message was rejected. Stays on the device: on the wire every rejection is
// PARSE_UNSUPPORTED (see tk_parse_status). Checks run in the order listed in SOLANA.md, and the
// first failing check decides the result. Keep tools/gen-vectors.mjs PARSE_REASONS in sync.
typedef enum {
    TK_PARSE_OK = 0,
    // structure
    TK_PARSE_TOO_LARGE,       // len > TK_MAX_MESSAGE_LEN
    TK_PARSE_TRUNCATED,       // a field runs past the end
    TK_PARSE_VERSIONED,       // first byte has the high bit set (v0+)
    TK_PARSE_BAD_COMPACT_U16, // non-canonical or > 0xFFFF
    TK_PARSE_TRAILING_BYTES,  // bytes left after the last instruction
    // common checks
    TK_PARSE_BAD_HEADER,          // signatures != 1, readonly_signed != 0, or readonly_unsigned >= N
    TK_PARSE_FEE_PAYER,           // account_keys[0] != device
    TK_PARSE_DUPLICATE_KEY,       // a key appears twice in account_keys
    TK_PARSE_INSTRUCTION_COUNT,   // not exactly one instruction
    TK_PARSE_INDEX_OUT_OF_RANGE,  // program or account index >= N
    TK_PARSE_UNSUPPORTED_PROGRAM, // not System Program or SPL Token
    // Shape A
    TK_PARSE_SOL_LAYOUT,          // not a 2-account, 12-byte Transfer
    TK_PARSE_SOL_FROM_NOT_DEVICE,
    // Shape B
    TK_PARSE_TOKEN_LAYOUT,        // not a 4-account, 10-byte TransferChecked
    TK_PARSE_TOKEN_WRONG_MINT,
    TK_PARSE_TOKEN_WRONG_DECIMALS,
    TK_PARSE_TOKEN_WRONG_SOURCE,  // source != the device's USDC token account
    TK_PARSE_TOKEN_OWNER_NOT_DEVICE,
    // Shapes C and D (staking), in check order
    TK_PARSE_STAKE_LAYOUT,              // wrong program, discriminator, data length or account count
    TK_PARSE_STAKE_FUNDER_NOT_DEVICE,   // CreateAccountWithSeed funder != device
    TK_PARSE_STAKE_BASE_NOT_DEVICE,     // CreateAccountWithSeed base != device
    TK_PARSE_STAKE_SEED,                // seed is not exactly "tk-stake-0" .. "tk-stake-15"
    TK_PARSE_STAKE_WRONG_OWNER,         // new account owner != Stake Program
    TK_PARSE_STAKE_WRONG_SPACE,         // space != 200
    TK_PARSE_STAKE_ADDRESS_MISMATCH,    // new account != SHA256(base || seed || owner)
    TK_PARSE_STAKE_WRONG_ACCOUNT,       // Initialize/Delegate on a different stake account
    TK_PARSE_STAKE_WRONG_SYSVAR,        // rent, clock, stake history or config ID wrong
    TK_PARSE_STAKE_AUTHORITY_NOT_DEVICE, // staker, withdrawer or signing authority != device
    TK_PARSE_STAKE_LOCKUP,              // lockup not entirely zero (timestamp, epoch, custodian)
    TK_PARSE_STAKE_WRONG_VALIDATOR,     // vote account != the pinned validator
    TK_PARSE_STAKE_NOT_DERIVED,         // Deactivate on an account that is not one of the device's tk-stake-<n>
} tk_parse_result_t;

// Parse a legacy message. device_usdc_ata is the device's own USDC associated token account,
// computed on device (core/ata) when the wallet loads. On any result other than TK_PARSE_OK,
// *out is zeroed.
tk_parse_result_t tk_parse_message(const uint8_t *msg, size_t len,
                                   const uint8_t device_pubkey[TK_PUBKEY_LEN],
                                   const uint8_t device_usdc_ata[TK_PUBKEY_LEN], tk_tx_t *out);

// TK_PARSE_OK -> TK_STATUS_OK; every rejection -> TK_STATUS_PARSE_UNSUPPORTED.
tk_status_t tk_parse_status(tk_parse_result_t r);

// Read a Solana compact-u16 from p (avail bytes available). Canonical encodings only, matching
// Solana's short_vec: at most 3 bytes, no trailing 0x00 byte unless it is the only byte, and the
// 3rd byte <= 0x03. Returns TK_PARSE_OK, TK_PARSE_TRUNCATED, or TK_PARSE_BAD_COMPACT_U16.
tk_parse_result_t tk_compact_u16_read(const uint8_t *p, size_t avail, uint16_t *value, size_t *used);

#endif
