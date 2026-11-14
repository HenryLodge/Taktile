// On-device associated token account (ATA) derivation. See docs/SOLANA.md.

#ifndef TK_ATA_H
#define TK_ATA_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_ed25519_point.h" // tk_ed25519_on_curve
#include "tk_solana_consts.h"

// ATA(wallet, mint) = find_program_address([wallet, TOKEN_PROGRAM, mint], ATA_PROGRAM).
// Tries bumps 255 down to 0 and returns the first SHA-256 candidate that is NOT an ed25519 point,
// with its bump. Returns false (and zeroes ata) on NULL arguments, or if no bump works
// (probability ~2^-256). Callers pass TK_DEVNET_USDC_MINT as the mint.
bool tk_ata_derive(const uint8_t wallet[TK_PUBKEY_LEN], const uint8_t mint[TK_PUBKEY_LEN],
                   uint8_t ata[TK_PUBKEY_LEN], uint8_t *bump);

// The candidate address for one bump: SHA256(wallet || TOKEN_PROGRAM || mint || [bump] ||
// ATA_PROGRAM || "ProgramDerivedAddress"). Exposed for tests.
void tk_ata_candidate(const uint8_t wallet[TK_PUBKEY_LEN], const uint8_t mint[TK_PUBKEY_LEN],
                      uint8_t bump, uint8_t out[TK_PUBKEY_LEN]);

#endif
