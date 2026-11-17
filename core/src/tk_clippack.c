#include "tk_clippack.h"

#include <string.h>

#include "tk_crc32.h"

static uint16_t rd16(const uint8_t *b) {
    return (uint16_t)(b[0] | (b[1] << 8));
}

static uint32_t rd32(const uint8_t *b) {
    return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}

tk_clippack_err_t tk_clippack_total_len(const uint8_t *hdr, size_t hdr_len, uint32_t *total_len) {
    *total_len = 0;
    if (hdr == NULL || hdr_len < TK_CLIPPACK_HEADER_LEN) {
        return TK_CLIPPACK_TOO_SHORT;
    }
    if (memcmp(hdr, "TKCP", 4) != 0) {
        return TK_CLIPPACK_BAD_MAGIC;
    }
    if (rd16(hdr + 4) != TK_CLIPPACK_VERSION) {
        return TK_CLIPPACK_BAD_VERSION;
    }
    *total_len = rd32(hdr + 8);
    return TK_CLIPPACK_OK;
}

tk_clippack_err_t tk_clippack_open(tk_clippack_t *p, const uint8_t *buf, size_t len,
                                   uint16_t expect_count, uint32_t expect_fingerprint) {
    memset(p, 0, sizeof(*p));
    uint32_t total = 0;
    const tk_clippack_err_t e = tk_clippack_total_len(buf, len, &total);
    if (e != TK_CLIPPACK_OK) {
        return e;
    }
    const uint16_t count = rd16(buf + 6);
    // 64-bit math: 20 + 8 * 65535 can't overflow, and total is compared as a size.
    const uint64_t data_start = TK_CLIPPACK_HEADER_LEN + 8u * (uint64_t)count;
    if ((uint64_t)total > (uint64_t)len || data_start > (uint64_t)total) {
        return TK_CLIPPACK_TOO_SHORT;
    }
    if (count != expect_count) {
        return TK_CLIPPACK_WRONG_COUNT;
    }
    if (rd32(buf + 12) != expect_fingerprint) {
        return TK_CLIPPACK_WRONG_FINGERPRINT;
    }
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *ent = buf + TK_CLIPPACK_HEADER_LEN + 8u * i;
        const uint32_t off = rd32(ent);
        const uint32_t n = rd32(ent + 4);
        if (off < data_start || off > total || n > total - off || (n & 1u) != 0) {
            return TK_CLIPPACK_BAD_ENTRY;
        }
    }
    p->buf = buf;
    p->len = total;
    p->count = count;
    p->data_start = (uint32_t)data_start;
    p->data_crc = rd32(buf + 16);
    return TK_CLIPPACK_OK;
}

tk_clippack_err_t tk_clippack_verify_crc(const tk_clippack_t *p) {
    if (p->buf == NULL) {
        return TK_CLIPPACK_TOO_SHORT;
    }
    const uint32_t crc = tk_crc32(p->buf + p->data_start, p->len - p->data_start);
    return crc == p->data_crc ? TK_CLIPPACK_OK : TK_CLIPPACK_BAD_CRC;
}

uint32_t tk_clippack_get(const tk_clippack_t *p, uint16_t id, const uint8_t **pcm) {
    *pcm = NULL;
    if (p->buf == NULL || id >= p->count) {
        return 0;
    }
    // Re-checked here as well as in open: cheap, and keeps this function safe on its own.
    const uint8_t *ent = p->buf + TK_CLIPPACK_HEADER_LEN + 8u * (uint32_t)id;
    const uint32_t off = rd32(ent);
    const uint32_t n = rd32(ent + 4);
    if (off < p->data_start || off > p->len || n > p->len - off || (n & 1u) != 0) {
        return 0;
    }
    *pcm = p->buf + off;
    return n;
}
