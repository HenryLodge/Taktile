// Is a 32-byte string an ed25519 point? Wraps ed25519-donna so core/ never includes donna's
// internal headers (which aren't written for core's -Werror warning set).

#ifndef TK_ED25519_POINT_H
#define TK_ED25519_POINT_H

#include <stdbool.h>
#include <stdint.h>

// True if p decompresses to a point, using the same rule as Solana on-chain
// (curve25519-dalek CompressedEdwardsY::decompress): the top bit is the sign of x and is ignored
// for y, y >= p is reduced mod p, and x = 0 with the sign bit set is accepted. See docs/SOLANA.md.
bool tk_ed25519_on_curve(const uint8_t p[32]);

#endif
