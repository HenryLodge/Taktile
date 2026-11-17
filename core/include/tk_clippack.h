// Clip pack: the device's audio clips in one flat image (written by tools/pack-clips.mjs, stored
// in the `clips` flash partition). Layout, all little-endian (docs/AUDIO.md):
//
//   0  "TKCP"   4  u16 version (1)   6  u16 count   8  u32 total_len
//  12  u32 fingerprint (TK_CLIPS_FINGERPRINT)   16  u32 data_crc (CRC-32 of [data_start, total_len))
//  20  count x {u32 offset, u32 len}   data_start = 20 + 8 * count
//
// Every bound is checked; nothing is allocated. A pack with the wrong count or fingerprint is
// refused: it was built for another clip list and would speak the wrong words.

#ifndef TK_CLIPPACK_H
#define TK_CLIPPACK_H

#include <stddef.h>
#include <stdint.h>

#define TK_CLIPPACK_HEADER_LEN 20u
#define TK_CLIPPACK_VERSION 1u

typedef enum {
    TK_CLIPPACK_OK = 0,
    TK_CLIPPACK_TOO_SHORT,         // fewer bytes than the header, index or total_len need
    TK_CLIPPACK_BAD_MAGIC,
    TK_CLIPPACK_BAD_VERSION,
    TK_CLIPPACK_WRONG_COUNT,       // not the clip count this build expects
    TK_CLIPPACK_WRONG_FINGERPRINT, // built for another clip list
    TK_CLIPPACK_BAD_ENTRY,         // an index entry points outside the data, or has an odd length
    TK_CLIPPACK_BAD_CRC,
} tk_clippack_err_t;

typedef struct {
    const uint8_t *buf;
    uint32_t len; // total_len
    uint16_t count;
    uint32_t data_start;
    uint32_t data_crc;
} tk_clippack_t;

// Reads total_len from the first TK_CLIPPACK_HEADER_LEN bytes (magic and version checked), so the
// caller knows how much to map before calling tk_clippack_open.
tk_clippack_err_t tk_clippack_total_len(const uint8_t *hdr, size_t hdr_len, uint32_t *total_len);

// Validates the header and every index entry of buf[0..len). len may exceed total_len (a whole
// partition). On success fills *p; on failure *p is zeroed.
tk_clippack_err_t tk_clippack_open(tk_clippack_t *p, const uint8_t *buf, size_t len,
                                   uint16_t expect_count, uint32_t expect_fingerprint);

// CRC-32 over the clip data. Slow (whole pack); call once after open.
tk_clippack_err_t tk_clippack_verify_crc(const tk_clippack_t *p);

// The PCM bytes (s16le mono 16 kHz) of clip id. Returns 0 and sets *pcm = NULL for an unknown id
// or an unopened pack.
uint32_t tk_clippack_get(const tk_clippack_t *p, uint16_t id, const uint8_t **pcm);

#endif
