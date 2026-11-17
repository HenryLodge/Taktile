#include "tk_clippack.h"
#include "tk_clips.h"
#include "tk_clips_fp.h"
#include "tk_crc32.h"
#include "tk_test.h"

#define FP 0x12345678u
#define N 3

static uint8_t pack[256];
static size_t pack_len;

static void wr16(uint8_t *b, uint16_t v) {
    b[0] = (uint8_t)v;
    b[1] = (uint8_t)(v >> 8);
}

static void wr32(uint8_t *b, uint32_t v) {
    for (int i = 0; i < 4; i++) {
        b[i] = (uint8_t)(v >> (8 * i));
    }
}

static void fix_crc(void) {
    const uint32_t ds = TK_CLIPPACK_HEADER_LEN + 8u * N;
    wr32(pack + 16, tk_crc32(pack + ds, pack_len - ds));
}

// Three clips of 4, 6 and 2 bytes, laid out the way tools/pack-clips.mjs does it.
static void build(void) {
    memset(pack, 0, sizeof(pack));
    static const uint32_t lens[N] = {4, 6, 2};
    uint32_t at = TK_CLIPPACK_HEADER_LEN + 8u * N; // 44
    memcpy(pack, "TKCP", 4);
    wr16(pack + 4, 1);
    wr16(pack + 6, N);
    wr32(pack + 12, FP);
    for (uint32_t i = 0; i < N; i++) {
        at = (at + 3u) & ~3u;
        wr32(pack + TK_CLIPPACK_HEADER_LEN + 8 * i, at);
        wr32(pack + TK_CLIPPACK_HEADER_LEN + 8 * i + 4, lens[i]);
        for (uint32_t k = 0; k < lens[i]; k++) {
            pack[at + k] = (uint8_t)(0x10 * (i + 1) + k);
        }
        at += lens[i];
    }
    pack_len = at;
    wr32(pack + 8, (uint32_t)pack_len);
    fix_crc();
}

static tk_clippack_err_t open_it(tk_clippack_t *p) {
    return tk_clippack_open(p, pack, pack_len, N, FP);
}

int main(void) {
    tk_clippack_t p;
    const uint8_t *pcm;

    // The generated fingerprint header exists and is what the firmware will check.
    TK_CHECK(TK_CLIPS_FINGERPRINT != 0u);
    TK_CHECK(TK_CLIP_COUNT > 0);

    // Valid pack.
    build();
    TK_CHECK(open_it(&p) == TK_CLIPPACK_OK);
    TK_CHECK(tk_clippack_verify_crc(&p) == TK_CLIPPACK_OK);
    TK_CHECK(tk_clippack_get(&p, 0, &pcm) == 4 && pcm[0] == 0x10 && pcm[3] == 0x13);
    TK_CHECK(tk_clippack_get(&p, 1, &pcm) == 6 && pcm[0] == 0x20 && pcm[5] == 0x25);
    TK_CHECK(tk_clippack_get(&p, 2, &pcm) == 2 && pcm[1] == 0x31);
    TK_CHECK(tk_clippack_get(&p, 3, &pcm) == 0 && pcm == NULL); // unknown id
    uint32_t total;
    TK_CHECK(tk_clippack_total_len(pack, TK_CLIPPACK_HEADER_LEN, &total) == TK_CLIPPACK_OK &&
             total == pack_len);

    // A whole partition behind the pack is fine (len > total_len).
    TK_CHECK(tk_clippack_open(&p, pack, sizeof(pack), N, FP) == TK_CLIPPACK_OK);

    // Truncated: header, index, data.
    TK_CHECK(tk_clippack_open(&p, pack, 19, N, FP) == TK_CLIPPACK_TOO_SHORT);
    TK_CHECK(tk_clippack_open(&p, pack, 30, N, FP) == TK_CLIPPACK_TOO_SHORT);
    TK_CHECK(tk_clippack_open(&p, pack, pack_len - 1, N, FP) == TK_CLIPPACK_TOO_SHORT);
    TK_CHECK(p.buf == NULL && tk_clippack_get(&p, 0, &pcm) == 0); // failed open leaves nothing usable
    TK_CHECK(tk_clippack_open(&p, NULL, 0, N, FP) == TK_CLIPPACK_TOO_SHORT);

    // Magic, version.
    build();
    pack[0] = 'X';
    TK_CHECK(open_it(&p) == TK_CLIPPACK_BAD_MAGIC);
    build();
    wr16(pack + 4, 2);
    TK_CHECK(open_it(&p) == TK_CLIPPACK_BAD_VERSION);

    // Built for another clip list.
    build();
    TK_CHECK(tk_clippack_open(&p, pack, pack_len, N + 1, FP) == TK_CLIPPACK_WRONG_COUNT);
    TK_CHECK(tk_clippack_open(&p, pack, pack_len, N, FP ^ 1u) == TK_CLIPPACK_WRONG_FINGERPRINT);

    // Count so large the index runs past total_len.
    build();
    wr16(pack + 6, 0xFFFF);
    TK_CHECK(tk_clippack_open(&p, pack, pack_len, 0xFFFF, FP) == TK_CLIPPACK_TOO_SHORT);

    // total_len claims more than we have.
    build();
    wr32(pack + 8, 0xFFFFFFFFu);
    TK_CHECK(open_it(&p) == TK_CLIPPACK_TOO_SHORT);

    // Entry: offset inside the index, past the end, offset + len overflowing, odd length.
    build();
    wr32(pack + TK_CLIPPACK_HEADER_LEN + 8, 8); // clip 1 points into the header/index
    TK_CHECK(open_it(&p) == TK_CLIPPACK_BAD_ENTRY);
    build();
    wr32(pack + TK_CLIPPACK_HEADER_LEN + 8, (uint32_t)pack_len + 4);
    TK_CHECK(open_it(&p) == TK_CLIPPACK_BAD_ENTRY);
    build();
    wr32(pack + TK_CLIPPACK_HEADER_LEN + 12, 0xFFFFFFFEu); // off + len wraps in 32 bits
    TK_CHECK(open_it(&p) == TK_CLIPPACK_BAD_ENTRY);
    build();
    wr32(pack + TK_CLIPPACK_HEADER_LEN + 4, 3);
    TK_CHECK(open_it(&p) == TK_CLIPPACK_BAD_ENTRY);

    // One flipped sample: header still opens, CRC catches it.
    build();
    pack[pack_len - 1] ^= 0x01;
    TK_CHECK(open_it(&p) == TK_CLIPPACK_OK);
    TK_CHECK(tk_clippack_verify_crc(&p) == TK_CLIPPACK_BAD_CRC);

    return tk_test_result();
}
