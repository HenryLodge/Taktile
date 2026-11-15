#include "ws.h"

#include <stdio.h>
#include <string.h>

#include "sha2.h"

static const char GUID[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void base64(const uint8_t *in, size_t len, char *out) {
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        const uint32_t v = ((uint32_t)in[i] << 16) | (i + 1 < len ? (uint32_t)in[i + 1] << 8 : 0) |
                           (i + 2 < len ? in[i + 2] : 0);
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = i + 1 < len ? B64[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? B64[v & 63] : '=';
    }
    out[o] = '\0';
}

void ws_accept_key(const char *key, size_t key_len, char out[WS_ACCEPT_LEN + 1]) {
    SHA1_CTX ctx;
    uint8_t digest[SHA1_DIGEST_LENGTH];
    sha1_Init(&ctx);
    sha1_Update(&ctx, (const uint8_t *)key, key_len);
    sha1_Update(&ctx, (const uint8_t *)GUID, sizeof(GUID) - 1);
    sha1_Final(&ctx, digest);
    base64(digest, sizeof(digest), out);
}

static char lower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

static bool starts_with_ci(const char *s, size_t len, const char *prefix) {
    const size_t n = strlen(prefix);
    if (len < n) {
        return false;
    }
    for (size_t i = 0; i < n; i++) {
        if (lower(s[i]) != lower(prefix[i])) {
            return false;
        }
    }
    return true;
}

static bool contains_ci(const char *s, size_t len, const char *needle) {
    const size_t n = strlen(needle);
    for (size_t i = 0; i + n <= len; i++) {
        if (starts_with_ci(s + i, len - i, needle)) {
            return true;
        }
    }
    return false;
}

bool ws_origin_allowed(const char *origin, size_t len) {
    static const char *const hosts[] = {"http://localhost", "https://localhost", "http://127.0.0.1",
                                        "https://127.0.0.1"};
    for (size_t h = 0; h < sizeof(hosts) / sizeof(hosts[0]); h++) {
        const size_t n = strlen(hosts[h]);
        if (len >= n && memcmp(origin, hosts[h], n) == 0) {
            if (len == n) {
                return true;
            }
            if (origin[n] != ':' || len == n + 1) {
                continue;
            }
            bool digits = true;
            for (size_t i = n + 1; i < len; i++) {
                digits = digits && origin[i] >= '0' && origin[i] <= '9';
            }
            if (digits) {
                return true;
            }
        }
    }
    return false;
}

static ws_hs_result_t reply(char *resp, size_t cap, ws_hs_result_t r, const char *accept) {
    if (r == WS_HS_OK) {
        snprintf(resp, cap,
                 "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                 "Sec-WebSocket-Accept: %s\r\n\r\n",
                 accept);
    } else if (r == WS_HS_FORBIDDEN) {
        snprintf(resp, cap, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    } else {
        snprintf(resp, cap, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    return r;
}

ws_hs_result_t ws_handshake(const char *req, size_t len, char *resp, size_t cap, size_t *consumed) {
    size_t end = 0;
    for (size_t i = 0; i + 4 <= len; i++) {
        if (memcmp(req + i, "\r\n\r\n", 4) == 0) {
            end = i + 4;
            break;
        }
    }
    if (end == 0) {
        if (len >= WS_MAX_REQUEST) {
            *consumed = len;
            return reply(resp, cap, WS_HS_BAD_REQUEST, NULL);
        }
        return WS_HS_NEED_MORE;
    }
    *consumed = end;
    if (!starts_with_ci(req, end, "GET ")) {
        return reply(resp, cap, WS_HS_BAD_REQUEST, NULL);
    }

    const char *key = NULL;
    size_t key_len = 0;
    bool upgrade = false, connection = false, version = false, origin_ok = true;
    // Walk header lines after the request line.
    size_t pos = 0;
    while (pos < end && req[pos] != '\n') {
        pos++;
    }
    pos++;
    while (pos + 2 <= end) {
        size_t eol = pos;
        while (eol + 1 < end && !(req[eol] == '\r' && req[eol + 1] == '\n')) {
            eol++;
        }
        if (eol == pos) {
            break; // blank line
        }
        const char *line = req + pos;
        const size_t n = eol - pos;
        size_t colon = 0;
        while (colon < n && line[colon] != ':') {
            colon++;
        }
        if (colon < n) {
            size_t v = colon + 1;
            while (v < n && (line[v] == ' ' || line[v] == '\t')) {
                v++;
            }
            size_t ve = n;
            while (ve > v && (line[ve - 1] == ' ' || line[ve - 1] == '\t')) {
                ve--;
            }
            const char *value = line + v;
            const size_t vlen = ve - v;
            if (colon == 7 && starts_with_ci(line, n, "upgrade")) {
                upgrade = vlen == 9 && starts_with_ci(value, vlen, "websocket");
            } else if (colon == 10 && starts_with_ci(line, n, "connection")) {
                connection = contains_ci(value, vlen, "upgrade");
            } else if (colon == 17 && starts_with_ci(line, n, "sec-websocket-key")) {
                key = value;
                key_len = vlen;
            } else if (colon == 21 && starts_with_ci(line, n, "sec-websocket-version")) {
                version = vlen == 2 && memcmp(value, "13", 2) == 0;
            } else if (colon == 6 && starts_with_ci(line, n, "origin")) {
                origin_ok = ws_origin_allowed(value, vlen);
            }
        }
        pos = eol + 2;
    }
    if (!origin_ok) {
        return reply(resp, cap, WS_HS_FORBIDDEN, NULL);
    }
    if (!upgrade || !connection || !version || key == NULL || key_len == 0 || key_len > 64) {
        return reply(resp, cap, WS_HS_BAD_REQUEST, NULL);
    }
    char accept[WS_ACCEPT_LEN + 1];
    ws_accept_key(key, key_len, accept);
    return reply(resp, cap, WS_HS_OK, accept);
}

void ws_decoder_init(ws_decoder_t *d) {
    d->len = 0;
    d->frame_len = 0;
}

static void drop_frame(ws_decoder_t *d) {
    if (d->frame_len > 0) {
        memmove(d->buf, d->buf + d->frame_len, d->len - d->frame_len);
        d->len -= d->frame_len;
        d->frame_len = 0;
    }
}

size_t ws_feed(ws_decoder_t *d, const uint8_t *in, size_t len) {
    drop_frame(d);
    const size_t room = sizeof(d->buf) - d->len;
    const size_t n = len < room ? len : room;
    memcpy(d->buf + d->len, in, n);
    d->len += n;
    return n;
}

ws_event_t ws_next(ws_decoder_t *d, const uint8_t **payload, size_t *plen) {
    drop_frame(d);
    if (d->len < 2) {
        return WS_NEED_MORE;
    }
    const uint8_t b0 = d->buf[0], b1 = d->buf[1];
    const uint8_t opcode = b0 & 0x0F;
    if ((b0 & 0x70) != 0 || (b1 & 0x80) == 0) {
        return WS_ERROR; // reserved bits set, or an unmasked client frame
    }
    uint64_t n = b1 & 0x7F;
    size_t hdr = 2;
    if (n == 126) {
        if (d->len < 4) {
            return WS_NEED_MORE;
        }
        n = ((uint64_t)d->buf[2] << 8) | d->buf[3];
        hdr = 4;
    } else if (n == 127) {
        if (d->len < 10) {
            return WS_NEED_MORE;
        }
        n = 0;
        for (size_t i = 0; i < 8; i++) {
            n = (n << 8) | d->buf[2 + i];
        }
        hdr = 10;
    }
    if (n > WS_MAX_PAYLOAD) {
        return WS_ERROR;
    }
    const bool control = (opcode & 0x8) != 0;
    if (control && (n > 125 || (b0 & 0x80) == 0)) {
        return WS_ERROR; // control frames are short and unfragmented
    }
    const size_t total = hdr + 4 + (size_t)n;
    if (d->len < total) {
        return WS_NEED_MORE;
    }
    const uint8_t *mask = d->buf + hdr;
    uint8_t *p = d->buf + hdr + 4;
    for (size_t i = 0; i < (size_t)n; i++) {
        p[i] ^= mask[i & 3];
    }
    d->frame_len = total;
    *payload = p;
    *plen = (size_t)n;
    switch (opcode) {
    case WS_OP_BINARY:
    case WS_OP_CONTINUATION:
        return WS_DATA;
    case WS_OP_PING:
        return WS_PING;
    case WS_OP_PONG:
        return WS_PONG;
    case WS_OP_CLOSE:
        return WS_CLOSE;
    default:
        return WS_ERROR; // text frames and reserved opcodes
    }
}

size_t ws_encode(uint8_t opcode, const uint8_t *payload, size_t len, uint8_t *out, size_t cap) {
    size_t hdr = len < 126 ? 2 : len <= 0xFFFF ? 4 : 10;
    if (cap < hdr + len) {
        return 0;
    }
    out[0] = (uint8_t)(0x80 | (opcode & 0x0F));
    if (len < 126) {
        out[1] = (uint8_t)len;
    } else if (len <= 0xFFFF) {
        out[1] = 126;
        out[2] = (uint8_t)(len >> 8);
        out[3] = (uint8_t)len;
    } else {
        out[1] = 127;
        for (size_t i = 0; i < 8; i++) {
            out[2 + i] = (uint8_t)((uint64_t)len >> (8 * (7 - i)));
        }
    }
    if (len > 0) {
        memcpy(out + hdr, payload, len);
    }
    return hdr + len;
}
