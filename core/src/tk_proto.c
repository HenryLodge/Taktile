#include "tk_proto.h"

#include <string.h>

#include "tk_crc32.h"

tk_frame_enc_err_t tk_frame_encode(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len,
                                   uint8_t *out, size_t out_cap, size_t *out_len) {
    if (out == NULL || out_len == NULL || (payload == NULL && len > 0)) {
        return TK_FRAME_ENC_BAD_ARG;
    }
    if (len > TK_FRAME_MAX_PAYLOAD) {
        return TK_FRAME_ENC_TOO_LARGE;
    }
    const size_t total = TK_FRAME_HEADER_LEN + len + TK_FRAME_CRC_LEN;
    if (out_cap < total) {
        return TK_FRAME_ENC_BUFFER_TOO_SMALL;
    }

    out[0] = TK_FRAME_MAGIC;
    out[1] = TK_FRAME_VERSION;
    out[2] = type;
    out[3] = seq;
    out[4] = (uint8_t)(len & 0xFFu);
    out[5] = (uint8_t)(len >> 8);
    if (len > 0) {
        memcpy(out + TK_FRAME_HEADER_LEN, payload, len);
    }

    const uint32_t crc = tk_crc32(out, TK_FRAME_HEADER_LEN + len);
    uint8_t *c = out + TK_FRAME_HEADER_LEN + len;
    c[0] = (uint8_t)(crc & 0xFFu);
    c[1] = (uint8_t)((crc >> 8) & 0xFFu);
    c[2] = (uint8_t)((crc >> 16) & 0xFFu);
    c[3] = (uint8_t)(crc >> 24);

    *out_len = total;
    return TK_FRAME_ENC_OK;
}

void tk_frame_decoder_init(tk_frame_decoder_t *d) {
    d->filled = 0;
    d->delivered = 0;
}

void tk_frame_decoder_reset(tk_frame_decoder_t *d) {
    tk_frame_decoder_init(d);
}

static void drop_front(tk_frame_decoder_t *d, size_t n) {
    if (n >= d->filled) {
        d->filled = 0;
        return;
    }
    memmove(d->buf, d->buf + n, d->filled - n);
    d->filled -= n;
}

static void set_error(tk_frame_t *out, uint8_t type, uint8_t seq) {
    out->type = type;
    out->seq = seq;
    out->seq_valid = true;
    out->payload = NULL;
    out->len = 0;
}

// Look at the buffered bytes and report at most one event. Never reads past d->filled.
static tk_frame_result_t scan(tk_frame_decoder_t *d, tk_frame_t *out) {
    // Skip anything before the next magic byte.
    size_t skip = 0;
    while (skip < d->filled && d->buf[skip] != TK_FRAME_MAGIC) {
        skip++;
    }
    drop_front(d, skip);

    if (d->filled < TK_FRAME_HEADER_LEN) {
        return TK_FRAME_NEED_MORE;
    }

    const uint8_t type = d->buf[2];
    const uint8_t seq = d->buf[3];
    if (d->buf[1] != TK_FRAME_VERSION) {
        set_error(out, type, seq);
        drop_front(d, 1); // resync from the next magic byte inside this header
        return TK_FRAME_BAD_FRAME;
    }

    const uint16_t len = (uint16_t)(d->buf[4] | ((uint16_t)d->buf[5] << 8));
    if (len > TK_FRAME_MAX_PAYLOAD) {
        set_error(out, type, seq);
        drop_front(d, 1);
        return TK_FRAME_TOO_LARGE;
    }

    const size_t total = TK_FRAME_HEADER_LEN + (size_t)len + TK_FRAME_CRC_LEN;
    if (d->filled < total) {
        return TK_FRAME_NEED_MORE;
    }

    const uint8_t *c = d->buf + TK_FRAME_HEADER_LEN + len;
    const uint32_t got = (uint32_t)c[0] | ((uint32_t)c[1] << 8) | ((uint32_t)c[2] << 16) |
                         ((uint32_t)c[3] << 24);
    if (got != tk_crc32(d->buf, TK_FRAME_HEADER_LEN + len)) {
        set_error(out, type, seq);
        drop_front(d, 1); // a real frame may start inside the rejected bytes
        return TK_FRAME_BAD_FRAME;
    }

    out->type = type;
    out->seq = seq;
    out->seq_valid = true;
    out->payload = d->buf + TK_FRAME_HEADER_LEN;
    out->len = len;
    d->delivered = total; // keep the bytes until the caller is done with out->payload
    return TK_FRAME_OK;
}

tk_frame_result_t tk_frame_decoder_feed(tk_frame_decoder_t *d, const uint8_t *data, size_t len,
                                        size_t *consumed, tk_frame_t *out) {
    *consumed = 0;
    if (d->delivered > 0) {
        drop_front(d, d->delivered);
        d->delivered = 0;
    }

    for (;;) {
        const tk_frame_result_t r = scan(d, out);
        if (r != TK_FRAME_NEED_MORE) {
            return r;
        }
        if (*consumed == len) {
            return TK_FRAME_NEED_MORE;
        }
        // scan() returning NEED_MORE guarantees filled < the frame's total length <=
        // TK_FRAME_MAX_LEN, so there is always room for one more byte. Check anyway.
        if (d->filled >= sizeof(d->buf)) {
            d->filled = 0;
        }
        d->buf[d->filled++] = data[(*consumed)++];
    }
}
