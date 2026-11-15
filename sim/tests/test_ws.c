// Unit tests for the simulator's WebSocket codec, base58, key decoding and clip text.

#include <stdlib.h>

#include "tk_clips.h"
#include "tk_solana_consts.h"
#include "tk_test.h"
#include "util.h"
#include "ws.h"

static void test_accept_key(void) {
    char out[WS_ACCEPT_LEN + 1];
    const char *key = "dGhlIHNhbXBsZSBub25jZQ=="; // RFC 6455 section 1.3
    ws_accept_key(key, strlen(key), out);
    TK_CHECK(strcmp(out, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") == 0);
}

#define REQ(origin)                                                                                  \
    "GET /chat HTTP/1.1\r\nHost: localhost:8765\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n" \
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" origin "\r\n"

static ws_hs_result_t hs(const char *req, char *resp, size_t *used) {
    return ws_handshake(req, strlen(req), resp, 256, used);
}

static void test_handshake(void) {
    char resp[256];
    size_t used = 0;
    const char *ok = REQ("Origin: http://localhost:5173\r\n");
    TK_CHECK(hs(ok, resp, &used) == WS_HS_OK);
    TK_CHECK(used == strlen(ok));
    TK_CHECK(strstr(resp, "101 Switching Protocols") != NULL);
    TK_CHECK(strstr(resp, "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") != NULL);

    TK_CHECK(hs(REQ(""), resp, &used) == WS_HS_OK); // no Origin: non-browser client
    TK_CHECK(hs(REQ("Origin: http://127.0.0.1:8080\r\n"), resp, &used) == WS_HS_OK);
    TK_CHECK(hs(REQ("Origin: https://evil.example\r\n"), resp, &used) == WS_HS_FORBIDDEN);
    TK_CHECK(strstr(resp, "403") != NULL);
    TK_CHECK(hs(REQ("Origin: http://localhost.evil.example\r\n"), resp, &used) == WS_HS_FORBIDDEN);
    TK_CHECK(hs(REQ("Origin: null\r\n"), resp, &used) == WS_HS_FORBIDDEN);

    // Incomplete, then missing pieces.
    const char *partial = "GET / HTTP/1.1\r\nUpgrade: websocket\r\n";
    TK_CHECK(ws_handshake(partial, strlen(partial), resp, sizeof(resp), &used) == WS_HS_NEED_MORE);
    const char *nokey = "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n";
    TK_CHECK(hs(nokey, resp, &used) == WS_HS_BAD_REQUEST);
    const char *post = "POST / HTTP/1.1\r\n\r\n";
    TK_CHECK(hs(post, resp, &used) == WS_HS_BAD_REQUEST);
    const char *v8 = "GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\n"
                     "Sec-WebSocket-Version: 8\r\n\r\n";
    TK_CHECK(hs(v8, resp, &used) == WS_HS_BAD_REQUEST);
    // An endless header block is refused once it reaches the limit.
    static char big[WS_MAX_REQUEST];
    memset(big, 'a', sizeof(big));
    TK_CHECK(ws_handshake(big, sizeof(big), resp, sizeof(resp), &used) == WS_HS_BAD_REQUEST);
}

static void test_origin(void) {
    static const struct {
        const char *o;
        bool ok;
    } cases[] = {
        {"http://localhost", true},     {"http://localhost:5173", true}, {"https://localhost:1", true},
        {"http://127.0.0.1:80", true},  {"http://localhost:", false},    {"http://localhost:5x", false},
        {"http://localhostx", false},   {"http://example.com", false},   {"file://", false},
        {"http://127.0.0.10", false},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        TK_CHECK(ws_origin_allowed(cases[i].o, strlen(cases[i].o)) == cases[i].ok);
    }
}

// Build a masked client frame.
static size_t client_frame(uint8_t opcode, bool fin, const uint8_t *p, size_t len, uint8_t *out) {
    static const uint8_t mask[4] = {0x37, 0xfa, 0x21, 0x3d};
    size_t h = 0;
    out[h++] = (uint8_t)((fin ? 0x80 : 0) | opcode);
    if (len < 126) {
        out[h++] = (uint8_t)(0x80 | len);
    } else if (len <= 0xFFFF) {
        out[h++] = 0x80 | 126;
        out[h++] = (uint8_t)(len >> 8);
        out[h++] = (uint8_t)len;
    } else {
        out[h++] = 0x80 | 127;
        for (int i = 7; i >= 0; i--) {
            out[h++] = (uint8_t)((uint64_t)len >> (8 * i));
        }
    }
    memcpy(out + h, mask, 4);
    h += 4;
    for (size_t i = 0; i < len; i++) {
        out[h + i] = p[i] ^ mask[i & 3];
    }
    return h + len;
}

static ws_decoder_t dec;

static void test_frames(void) {
    static uint8_t frame[14 + WS_MAX_PAYLOAD + 16];
    static uint8_t payload[WS_MAX_PAYLOAD + 1];
    for (size_t i = 0; i < sizeof(payload); i++) {
        payload[i] = (uint8_t)(i * 31 + 7);
    }
    const uint8_t *p;
    size_t n;

    // Short, 16-bit and 64-bit lengths (the 64-bit form at the maximum payload).
    const size_t lens[] = {0, 5, 125, 126, 300, 65535, WS_MAX_PAYLOAD};
    for (size_t i = 0; i < sizeof(lens) / sizeof(lens[0]); i++) {
        ws_decoder_init(&dec);
        const size_t fl = client_frame(WS_OP_BINARY, true, payload, lens[i], frame);
        TK_CHECK(ws_feed(&dec, frame, fl) == fl);
        TK_CHECK(ws_next(&dec, &p, &n) == WS_DATA);
        TK_CHECK(n == lens[i] && (n == 0 || memcmp(p, payload, n) == 0));
        TK_CHECK(ws_next(&dec, &p, &n) == WS_NEED_MORE);
    }

    // One byte at a time, and two frames (binary + continuation) back to back.
    ws_decoder_init(&dec);
    size_t fl = client_frame(WS_OP_BINARY, false, payload, 10, frame);
    fl += client_frame(WS_OP_CONTINUATION, true, payload + 10, 20, frame + fl);
    uint8_t got[64];
    size_t gl = 0;
    for (size_t i = 0; i < fl; i++) {
        ws_feed(&dec, frame + i, 1);
        ws_event_t e;
        while ((e = ws_next(&dec, &p, &n)) != WS_NEED_MORE) {
            TK_CHECK(e == WS_DATA);
            memcpy(got + gl, p, n);
            gl += n;
        }
    }
    TK_CHECK(gl == 30 && memcmp(got, payload, 30) == 0);

    // Control frames.
    ws_decoder_init(&dec);
    fl = client_frame(WS_OP_PING, true, (const uint8_t *)"hi", 2, frame);
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_PING && n == 2 && memcmp(p, "hi", 2) == 0);
    fl = client_frame(WS_OP_CLOSE, true, NULL, 0, frame);
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_CLOSE);
    fl = client_frame(WS_OP_PONG, true, NULL, 0, frame);
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_PONG);

    // Violations: text, unmasked, oversized, reserved bits, long or fragmented control frames.
    ws_decoder_init(&dec);
    fl = client_frame(WS_OP_TEXT, true, payload, 3, frame);
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    ws_decoder_init(&dec);
    const uint8_t unmasked[] = {0x82, 0x01, 0x41};
    ws_feed(&dec, unmasked, sizeof(unmasked));
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    ws_decoder_init(&dec);
    const uint8_t huge[] = {0x82, 0xFF, 0, 0, 0, 0, 0, 1, 0, 1}; // 65537 bytes declared
    ws_feed(&dec, huge, sizeof(huge));
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    ws_decoder_init(&dec);
    fl = client_frame(WS_OP_BINARY, true, payload, 1, frame);
    frame[0] |= 0x40;
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    ws_decoder_init(&dec);
    fl = client_frame(WS_OP_PING, true, payload, 126, frame);
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    ws_decoder_init(&dec);
    fl = client_frame(WS_OP_PING, false, payload, 1, frame);
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    ws_decoder_init(&dec);
    fl = client_frame(0x3, true, payload, 1, frame); // reserved opcode
    ws_feed(&dec, frame, fl);
    TK_CHECK(ws_next(&dec, &p, &n) == WS_ERROR);

    // Random bytes never crash or over-read.
    uint32_t x = 0xA5A5F00Du;
    for (int iter = 0; iter < 2000; iter++) {
        ws_decoder_init(&dec);
        uint8_t junk[64];
        for (size_t b = 0; b < sizeof(junk); b++) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            junk[b] = (uint8_t)x;
        }
        ws_feed(&dec, junk, (size_t)(x % sizeof(junk)));
        for (int k = 0; k < 8 && ws_next(&dec, &p, &n) > WS_NEED_MORE; k++) {
        }
    }
}

static void test_encode(void) {
    uint8_t out[16 + 300];
    uint8_t p[300];
    memset(p, 0x5A, sizeof(p));
    TK_CHECK(ws_encode(WS_OP_BINARY, p, 5, out, sizeof(out)) == 7);
    TK_CHECK(out[0] == 0x82 && out[1] == 5 && out[2] == 0x5A);
    TK_CHECK(ws_encode(WS_OP_BINARY, p, 300, out, sizeof(out)) == 304);
    TK_CHECK(out[1] == 126 && out[2] == 0x01 && out[3] == 0x2C);
    TK_CHECK(ws_encode(WS_OP_BINARY, p, 300, out, 303) == 0);
    TK_CHECK(ws_encode(WS_OP_PONG, NULL, 0, out, sizeof(out)) == 2 && out[0] == 0x8A);
}

static void test_base58(void) {
    uint8_t b[32];
    char s[45];
    TK_CHECK(sim_base58_decode32("11111111111111111111111111111111", b));
    TK_CHECK_MEM(b, TK_SYSTEM_PROGRAM_ID, 32);
    sim_base58_encode32(TK_SYSTEM_PROGRAM_ID, s);
    TK_CHECK(strcmp(s, "11111111111111111111111111111111") == 0);

    TK_CHECK(sim_base58_decode32("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", b));
    TK_CHECK_MEM(b, TK_DEVNET_USDC_MINT, 32);
    sim_base58_encode32(TK_DEVNET_USDC_MINT, s);
    TK_CHECK(strcmp(s, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") == 0);

    TK_CHECK(sim_base58_decode32("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", b));
    TK_CHECK_MEM(b, TK_TOKEN_PROGRAM_ID, 32);

    TK_CHECK(!sim_base58_decode32("", b));
    TK_CHECK(!sim_base58_decode32("0OIl", b));                                      // not in the alphabet
    TK_CHECK(!sim_base58_decode32("4zMMC9srt5Ri5X14GAgXhaHii3GnPAE", b)); // ~23 bytes, too short
    TK_CHECK(!sim_base58_decode32("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", b)); // > 32 bytes

    TK_CHECK(sim_parse_address("427ff53a173c8644ade89f73862e3c66e35d833aa0dfd47238a0dbffe0c766bc", b));
    TK_CHECK(b[0] == 0x42 && b[31] == 0xbc);
    TK_CHECK(!sim_parse_address("427ff53a173c8644ade89f73862e3c66e35d833aa0dfd47238a0dbffe0c766bg", b));

    // Round trip of random keys.
    uint32_t x = 12345;
    for (int iter = 0; iter < 500; iter++) {
        uint8_t k[32], back[32];
        for (size_t i = 0; i < 32; i++) {
            x = x * 1103515245u + 12345u;
            k[i] = (uint8_t)(x >> 16);
        }
        if (iter % 5 == 0) {
            k[0] = 0;
            k[1] = 0;
        }
        sim_base58_encode32(k, s);
        TK_CHECK(sim_base58_decode32(s, back));
        TK_CHECK_MEM(back, k, 32);
    }
}

static void test_keys(void) {
    static const struct {
        const char *in;
        size_t len;
        sim_key_kind_t kind;
        tk_button_t button;
    } cases[] = {
        {"\x1b[A", 3, SIM_KEY_BUTTON, TK_BTN_UP},       {"\x1b[B", 3, SIM_KEY_BUTTON, TK_BTN_DOWN},
        {"\x1bOA", 3, SIM_KEY_BUTTON, TK_BTN_UP},       {"\r", 1, SIM_KEY_BUTTON, TK_BTN_OK},
        {"\n", 1, SIM_KEY_BUTTON, TK_BTN_OK},           {"\x7f", 1, SIM_KEY_BUTTON, TK_BTN_BACK},
        {"\x08", 1, SIM_KEY_BUTTON, TK_BTN_BACK},       {"c", 1, SIM_KEY_BUTTON, TK_BTN_CONFIRM},
        {"r", 1, SIM_KEY_BUTTON, TK_BTN_REJECT},        {"O", 1, SIM_KEY_BUTTON, TK_BTN_OK_LONG},
        {"R", 1, SIM_KEY_BUTTON, TK_BTN_REJECT_LONG},   {"q", 1, SIM_KEY_QUIT, TK_BTN_NONE},
        {"x", 1, SIM_KEY_IGNORED, TK_BTN_NONE},         {"\x1b[C", 3, SIM_KEY_IGNORED, TK_BTN_NONE},
        {"\x1b[", 2, SIM_KEY_NEED_MORE, TK_BTN_NONE},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        size_t used = 0;
        tk_button_t b = TK_BTN_NONE;
        const sim_key_kind_t k = sim_decode_key((const uint8_t *)cases[i].in, cases[i].len, &used, &b);
        TK_CHECK(k == cases[i].kind);
        if (k == SIM_KEY_BUTTON) {
            TK_CHECK(b == cases[i].button && used == cases[i].len);
        }
    }
}

static void test_clip_text(void) {
    for (unsigned c = 0; c < TK_CLIP_COUNT; c++) {
        const char *t = sim_clip_text((uint16_t)c);
        TK_CHECK(t != NULL && t[0] != '\0' && strcmp(t, "(unknown clip)") != 0);
    }
    TK_CHECK(strcmp(sim_clip_text(TK_CLIP_WORD_0 + 0xE5), "topmost") == 0);
    TK_CHECK(strcmp(sim_clip_text(TK_CLIP_ZERO + 13), "thirteen") == 0);
    TK_CHECK(strcmp(sim_clip_text(TK_CLIP_TWENTY + 7), "ninety") == 0);
    TK_CHECK(strcmp(sim_clip_text(TK_CLIP_LETTER_A + 25), "Z") == 0);
    TK_CHECK(strcmp(sim_clip_text(TK_CLIP_COUNT), "(unknown clip)") == 0);
}

int main(void) {
    test_accept_key();
    test_handshake();
    test_origin();
    test_frames();
    test_encode();
    test_base58();
    test_keys();
    test_clip_text();
    return tk_test_result();
}
