// Writes the fuzz seed corpus from the generated parser vectors (tests/vectors/parser.json, as
// tk_parser_vectors.h), plus small clip packs. Usage: make_seeds <dir>; <dir>/parser, <dir>/frame
// and <dir>/clippack must exist.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tk_crc32.h"
#include "tk_parser_vectors.h"
#include "tk_proto.h"

static const char *out_dir;

static void write_file(const char *sub, const char *name, const uint8_t *data, size_t len) {
    char path[1024];
    const int n = snprintf(path, sizeof(path), "%s/%s/%s.bin", out_dir, sub, name);
    if (n < 0 || (size_t)n >= sizeof(path)) {
        fprintf(stderr, "make_seeds: path too long\n");
        exit(1);
    }
    FILE *f = fopen(path, "wb");
    if (f == NULL || (len > 0 && fwrite(data, 1, len, f) != len) || fclose(f) != 0) {
        fprintf(stderr, "make_seeds: can't write %s\n", path);
        exit(1);
    }
}

// Appends one encoded frame to buf at *at.
static void frame(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len, uint8_t *buf,
                  size_t cap, size_t *at) {
    size_t n = 0;
    if (tk_frame_encode(type, seq, payload, len, buf + *at, cap - *at, &n) != TK_FRAME_ENC_OK) {
        fprintf(stderr, "make_seeds: encode failed\n");
        exit(1);
    }
    *at += n;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: make_seeds <dir>\n");
        return 2;
    }
    out_dir = argv[1];
    static uint8_t buf[2 * TK_FRAME_MAX_LEN];
    size_t n;

    for (size_t i = 0; i < TK_PARSER_VECTOR_COUNT; i++) {
        const tk_parser_vector_t *v = &tk_parser_vectors[i];
        write_file("parser", v->name, v->msg, v->msg_len);
        if (v->msg_len <= TK_FRAME_MAX_PAYLOAD) {
            n = 0;
            frame(TK_MSG_SIGN_REQUEST, (uint8_t)i, v->msg, v->msg_len, buf, sizeof(buf), &n);
            write_file("frame", v->name, buf, n);
        }
    }

    n = 0;
    frame(TK_MSG_HELLO, 1, NULL, 0, buf, sizeof(buf), &n);
    write_file("frame", "hello", buf, n);

    n = 0;
    frame(TK_MSG_CANCEL, 2, NULL, 0, buf, sizeof(buf), &n);
    write_file("frame", "cancel", buf, n);

    // HELLO then a SIGN_REQUEST, back to back, with line noise in front.
    const tk_parser_vector_t *v0 = &tk_parser_vectors[0];
    buf[0] = 0x00;
    buf[1] = 0xE5;
    buf[2] = 0x7F;
    n = 3;
    frame(TK_MSG_HELLO, 3, NULL, 0, buf, sizeof(buf), &n);
    frame(TK_MSG_SIGN_REQUEST, 4, v0->msg, v0->msg_len, buf, sizeof(buf), &n);
    write_file("frame", "two_frames", buf, n);

    // Bad CRC on the first frame, a good one after it.
    n = 0;
    frame(TK_MSG_GET_PUBKEY, 5, NULL, 0, buf, sizeof(buf), &n);
    buf[n - 1] ^= 0xFF;
    frame(TK_MSG_GET_PUBKEY, 6, NULL, 0, buf, sizeof(buf), &n);
    write_file("frame", "bad_crc_then_good", buf, n);

    // A header claiming a payload of TK_FRAME_MAX_PAYLOAD + 1.
    const uint16_t big = TK_FRAME_MAX_PAYLOAD + 1;
    const uint8_t too_large[] = {TK_FRAME_MAGIC, TK_FRAME_VERSION, TK_MSG_SIGN_REQUEST, 7,
                                 (uint8_t)(big & 0xFF), (uint8_t)(big >> 8)};
    write_file("frame", "too_large", too_large, sizeof(too_large));

    // The largest legal frame.
    static uint8_t payload[TK_FRAME_MAX_PAYLOAD];
    memset(payload, 0xE5, sizeof(payload)); // magic bytes inside the payload
    n = 0;
    frame(TK_MSG_CONTACT_ADD, 8, payload, sizeof(payload), buf, sizeof(buf), &n);
    write_file("frame", "max_payload", buf, n);

    // A valid 3-clip pack (as tools/pack-clips.mjs lays it out), and the same truncated.
    static uint8_t pack[64];
    memset(pack, 0, sizeof(pack));
    memcpy(pack, "TKCP", 4);
    pack[4] = 1;                 // version
    pack[6] = 3;                 // count
    pack[8] = 60;                // total_len
    pack[12] = 0x78;             // fingerprint 0x12345678
    pack[13] = 0x56;
    pack[14] = 0x34;
    pack[15] = 0x12;
    const uint8_t index[3][2] = {{44, 4}, {48, 6}, {56, 2}}; // {offset, len}
    for (int i = 0; i < 3; i++) {
        pack[20 + 8 * i] = index[i][0];
        pack[24 + 8 * i] = index[i][1];
    }
    for (int i = 44; i < 60; i++) {
        pack[i] = (uint8_t)i;
    }
    const uint32_t crc = tk_crc32(pack + 44, 16);
    for (int i = 0; i < 4; i++) {
        pack[16 + i] = (uint8_t)(crc >> (8 * i));
    }
    write_file("clippack", "valid", pack, 60);
    write_file("clippack", "truncated", pack, 40);

    return 0;
}
