// Frame encoder/decoder tests: known bytes, round trips, chunking, corruption, truncation,
// and seeded random streams. Run under ASan/UBSan to catch any out-of-bounds access.

#include "tk_crc32.h"
#include "tk_proto.h"
#include "tk_test.h"

#define MAX_EVENTS 64
#define STREAM_CAP (64u * 1024u)

typedef struct {
    tk_frame_result_t result;
    uint8_t type;
    uint8_t seq;
    uint16_t len;
    uint8_t payload[TK_FRAME_MAX_PAYLOAD];
} event_t;

typedef struct {
    event_t ev[MAX_EVENTS];
    size_t count;
    size_t dropped; // events beyond MAX_EVENTS (counted, not stored)
    bool ok_only;   // record only TK_FRAME_OK events
} events_t;

static uint32_t rng_state;

static uint32_t rng(void) {
    // xorshift32: deterministic, so failures reproduce.
    uint32_t x = rng_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    rng_state = x;
    return x;
}

static void record(events_t *evs, tk_frame_result_t r, const tk_frame_t *f) {
    if (evs->ok_only && r != TK_FRAME_OK) {
        return;
    }
    if (evs->count >= MAX_EVENTS) {
        evs->dropped++;
        return;
    }
    event_t *e = &evs->ev[evs->count++];
    e->result = r;
    e->type = f->type;
    e->seq = f->seq;
    e->len = 0;
    if (r == TK_FRAME_OK) {
        e->len = f->len;
        memcpy(e->payload, f->payload, f->len);
    }
}

// Check what must hold for every OK, whatever the input.
static void check_ok_frame(const tk_frame_decoder_t *d, const tk_frame_t *f) {
    TK_CHECK(f->seq_valid);
    TK_CHECK(f->len <= TK_FRAME_MAX_PAYLOAD);
    TK_CHECK(f->payload >= d->buf + TK_FRAME_HEADER_LEN);
    TK_CHECK(f->payload + f->len + TK_FRAME_CRC_LEN <= d->buf + sizeof(d->buf));
    const uint8_t *hdr = f->payload - TK_FRAME_HEADER_LEN;
    const uint8_t *c = f->payload + f->len;
    const uint32_t stored = (uint32_t)c[0] | ((uint32_t)c[1] << 8) | ((uint32_t)c[2] << 16) |
                            ((uint32_t)c[3] << 24);
    TK_CHECK(hdr[0] == TK_FRAME_MAGIC);
    TK_CHECK(tk_crc32(hdr, TK_FRAME_HEADER_LEN + f->len) == stored);
}

// Feed data in chunks (chunk == 0 means random sizes 1..64) and drain every event,
// the way firmware will. Checks the decoder always makes progress.
static void feed(tk_frame_decoder_t *d, const uint8_t *data, size_t len, size_t chunk,
                 events_t *evs) {
    size_t pos = 0;
    while (pos < len) {
        size_t n = chunk ? chunk : 1 + (rng() % 64);
        if (n > len - pos) {
            n = len - pos;
        }
        size_t off = 0;
        for (;;) {
            size_t used = 0;
            tk_frame_t f;
            const tk_frame_result_t r = tk_frame_decoder_feed(d, data + pos + off, n - off, &used, &f);
            off += used;
            TK_CHECK(off <= n);
            if (r == TK_FRAME_NEED_MORE) {
                TK_CHECK(off == n); // NEED_MORE means all input was taken
                break;
            }
            if (r == TK_FRAME_OK) {
                check_ok_frame(d, &f);
            }
            record(evs, r, &f);
        }
        pos += n;
    }
}

static size_t encode(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len, uint8_t *out) {
    size_t n = 0;
    TK_CHECK(tk_frame_encode(type, seq, payload, len, out, TK_FRAME_MAX_LEN, &n) == TK_FRAME_ENC_OK);
    return n;
}

static void fill_payload(uint8_t *p, size_t len) {
    // Arbitrary bytes, but never the magic byte, so tests can control where frames start.
    for (size_t i = 0; i < len; i++) {
        uint8_t b = (uint8_t)rng();
        p[i] = (b == TK_FRAME_MAGIC) ? 0x00 : b;
    }
}

static void test_known_bytes(void) {
    uint8_t out[TK_FRAME_MAX_LEN];
    uint8_t want[10];
    size_t n = encode(TK_MSG_HELLO, 0x07, NULL, 0, out);
    tk_hex("e50101070000c273d877", want, sizeof(want)); // CRC from Python zlib.crc32
    TK_CHECK(n == sizeof(want));
    TK_CHECK_MEM(out, want, sizeof(want));
}

static void test_encoder_limits(void) {
    static uint8_t payload[TK_FRAME_MAX_PAYLOAD + 1];
    uint8_t out[TK_FRAME_MAX_LEN + 1];
    size_t n = 0;

    TK_CHECK(tk_frame_encode(1, 0, payload, TK_FRAME_MAX_PAYLOAD + 1, out, sizeof(out), &n) ==
             TK_FRAME_ENC_TOO_LARGE);
    TK_CHECK(tk_frame_encode(1, 0, payload, 10, out, TK_FRAME_HEADER_LEN + 10 + TK_FRAME_CRC_LEN - 1,
                             &n) == TK_FRAME_ENC_BUFFER_TOO_SMALL);
    TK_CHECK(tk_frame_encode(1, 0, NULL, 1, out, sizeof(out), &n) == TK_FRAME_ENC_BAD_ARG);
    TK_CHECK(tk_frame_encode(1, 0, payload, 0, NULL, sizeof(out), &n) == TK_FRAME_ENC_BAD_ARG);
    TK_CHECK(tk_frame_encode(1, 0, payload, TK_FRAME_MAX_PAYLOAD, out, TK_FRAME_MAX_LEN, &n) ==
             TK_FRAME_ENC_OK);
    TK_CHECK(n == TK_FRAME_MAX_LEN);
}

static void test_round_trip(void) {
    static const size_t lens[] = {0, 1, 255, 256, TK_FRAME_MAX_PAYLOAD};
    static const size_t chunks[] = {1, 7, TK_FRAME_MAX_LEN, 0};
    static uint8_t payload[TK_FRAME_MAX_PAYLOAD];
    static uint8_t frame[TK_FRAME_MAX_LEN];
    static events_t evs;

    for (size_t i = 0; i < sizeof(lens) / sizeof(lens[0]); i++) {
        fill_payload(payload, lens[i]);
        const size_t n = encode(TK_MSG_SIGN_REQUEST, (uint8_t)i, payload, lens[i], frame);
        for (size_t c = 0; c < sizeof(chunks) / sizeof(chunks[0]); c++) {
            tk_frame_decoder_t d;
            tk_frame_decoder_init(&d);
            evs.count = 0;
            feed(&d, frame, n, chunks[c], &evs);
            TK_CHECK(evs.count == 1);
            TK_CHECK(evs.ev[0].result == TK_FRAME_OK);
            TK_CHECK(evs.ev[0].type == TK_MSG_SIGN_REQUEST);
            TK_CHECK(evs.ev[0].seq == (uint8_t)i);
            TK_CHECK(evs.ev[0].len == lens[i]);
            TK_CHECK_MEM(evs.ev[0].payload, payload, lens[i]);
        }
    }
}

static void test_two_frames_one_chunk(void) {
    static uint8_t stream[2 * TK_FRAME_MAX_LEN];
    static events_t evs;
    const uint8_t a[3] = {1, 2, 3};
    const uint8_t b[2] = {9, 8};
    size_t n = encode(TK_MSG_HELLO, 1, a, sizeof(a), stream);
    n += encode(TK_MSG_GET_PUBKEY, 2, b, sizeof(b), stream + n);

    tk_frame_decoder_t d;
    tk_frame_decoder_init(&d);
    evs.count = 0;
    feed(&d, stream, n, n, &evs);
    TK_CHECK(evs.count == 2);
    TK_CHECK(evs.ev[0].result == TK_FRAME_OK && evs.ev[0].seq == 1 && evs.ev[0].len == 3);
    TK_CHECK(evs.ev[1].result == TK_FRAME_OK && evs.ev[1].seq == 2 && evs.ev[1].len == 2);
    TK_CHECK_MEM(evs.ev[1].payload, b, sizeof(b));
}

static void test_garbage_prefix(void) {
    static uint8_t stream[4 * TK_FRAME_MAX_LEN];
    static events_t evs;
    const uint8_t p[4] = {0xAA, TK_FRAME_MAGIC, 0x01, 0xBB}; // magic inside the payload too
    tk_frame_decoder_t d;

    // Noise without a magic byte: skipped silently.
    size_t n = 0;
    for (; n < 100; n++) {
        stream[n] = (uint8_t)(n == TK_FRAME_MAGIC ? 0 : n);
    }
    n += encode(TK_MSG_HELLO, 5, p, sizeof(p), stream + n);
    tk_frame_decoder_init(&d);
    evs.count = 0;
    feed(&d, stream, n, 0, &evs);
    TK_CHECK(evs.count == 1);
    TK_CHECK(evs.ev[0].result == TK_FRAME_OK && evs.ev[0].seq == 5);
    TK_CHECK_MEM(evs.ev[0].payload, p, sizeof(p));

    // Noise with stray magic bytes, including a fake header claiming a long payload that
    // swallows the real frame. Once enough padding arrives, the fake fails its CRC and the
    // decoder rescans inside it and still finds the real frame.
    const uint8_t noise[] = {TK_FRAME_MAGIC, 0x00, TK_FRAME_MAGIC, TK_FRAME_VERSION, 0x01, 0x02,
                             0x00, 0x04, 0x11};
    n = 0;
    memcpy(stream, noise, sizeof(noise));
    n += sizeof(noise);
    n += encode(TK_MSG_HELLO, 6, p, sizeof(p), stream + n);
    memset(stream + n, 0, TK_FRAME_MAX_LEN);
    n += TK_FRAME_MAX_LEN;
    tk_frame_decoder_init(&d);
    evs.count = 0;
    feed(&d, stream, n, 0, &evs);
    size_t ok = 0;
    for (size_t i = 0; i < evs.count; i++) {
        if (evs.ev[i].result == TK_FRAME_OK) {
            ok++;
            TK_CHECK(evs.ev[i].seq == 6);
            TK_CHECK_MEM(evs.ev[i].payload, p, sizeof(p));
        }
    }
    TK_CHECK(ok == 1);
}

static void test_errors_then_recovery(void) {
    static uint8_t stream[3 * TK_FRAME_MAX_LEN];
    static events_t evs;
    const uint8_t p[5] = {1, 2, 3, 4, 5};
    tk_frame_decoder_t d;
    size_t n;

    // Bad CRC.
    n = encode(TK_MSG_HELLO, 0x21, p, sizeof(p), stream);
    stream[n - 1] ^= 0x01;
    n += encode(TK_MSG_HELLO, 0x22, p, sizeof(p), stream + n);
    tk_frame_decoder_init(&d);
    evs.count = 0;
    feed(&d, stream, n, 0, &evs);
    TK_CHECK(evs.count == 2);
    TK_CHECK(evs.ev[0].result == TK_FRAME_BAD_FRAME && evs.ev[0].seq == 0x21);
    TK_CHECK(evs.ev[1].result == TK_FRAME_OK && evs.ev[1].seq == 0x22);

    // Bad version.
    n = encode(TK_MSG_HELLO, 0x31, p, sizeof(p), stream);
    stream[1] = 0x02;
    n += encode(TK_MSG_HELLO, 0x32, p, sizeof(p), stream + n);
    tk_frame_decoder_init(&d);
    evs.count = 0;
    feed(&d, stream, n, 0, &evs);
    TK_CHECK(evs.count == 2);
    TK_CHECK(evs.ev[0].result == TK_FRAME_BAD_FRAME && evs.ev[0].seq == 0x31);
    TK_CHECK(evs.ev[1].result == TK_FRAME_OK && evs.ev[1].seq == 0x32);

    // Header claims len = 2049.
    const uint8_t big[] = {TK_FRAME_MAGIC, TK_FRAME_VERSION, TK_MSG_SIGN_REQUEST, 0x41, 0x01, 0x08};
    memcpy(stream, big, sizeof(big));
    n = sizeof(big);
    n += encode(TK_MSG_HELLO, 0x42, p, sizeof(p), stream + n);
    tk_frame_decoder_init(&d);
    evs.count = 0;
    feed(&d, stream, n, 0, &evs);
    TK_CHECK(evs.count == 2);
    TK_CHECK(evs.ev[0].result == TK_FRAME_TOO_LARGE && evs.ev[0].seq == 0x41);
    TK_CHECK(evs.ev[1].result == TK_FRAME_OK && evs.ev[1].seq == 0x42);
}

static void test_truncation(void) {
    static uint8_t payload[300];
    static uint8_t frame[TK_FRAME_MAX_LEN];
    static events_t evs;
    fill_payload(payload, sizeof(payload));
    const size_t n = encode(TK_MSG_SIGN_REQUEST, 9, payload, sizeof(payload), frame);

    for (size_t k = 0; k < n; k++) {
        tk_frame_decoder_t d;
        tk_frame_decoder_init(&d);
        evs.count = 0;
        feed(&d, frame, k, 0, &evs);
        TK_CHECK(evs.count == 0); // every prefix: NEED_MORE, never an error

        // The rest completes it without a reset...
        feed(&d, frame + k, n - k, 0, &evs);
        TK_CHECK(evs.count == 1 && evs.ev[0].result == TK_FRAME_OK);

        // ...and after a reset mid-frame, a full frame decodes.
        tk_frame_decoder_reset(&d);
        evs.count = 0;
        feed(&d, frame, k, 0, &evs);
        tk_frame_decoder_reset(&d);
        feed(&d, frame, n, 0, &evs);
        TK_CHECK(evs.count == 1 && evs.ev[0].result == TK_FRAME_OK);
    }
}

static void test_bit_flips(void) {
    static uint8_t payload[32];
    static uint8_t frame[TK_FRAME_MAX_LEN];
    static uint8_t bad[TK_FRAME_MAX_LEN];
    static events_t evs;
    fill_payload(payload, sizeof(payload));
    const size_t n = encode(TK_MSG_SIGN_REQUEST, 3, payload, sizeof(payload), frame);

    for (size_t bit = 0; bit < n * 8; bit++) {
        memcpy(bad, frame, n);
        bad[bit / 8] ^= (uint8_t)(1u << (bit % 8));
        tk_frame_decoder_t d;
        tk_frame_decoder_init(&d);
        evs.count = 0;
        feed(&d, bad, n, 0, &evs);
        for (size_t i = 0; i < evs.count; i++) {
            TK_CHECK(evs.ev[i].result != TK_FRAME_OK);
        }
    }
}

// Random streams: garbage biased toward header-like bytes, with real frames mixed in.
// Every real frame must come back, in order, once trailing padding flushes any fake frame.
static void test_random_streams(void) {
    static uint8_t stream[STREAM_CAP];
    static uint8_t payloads[16][TK_FRAME_MAX_PAYLOAD];
    static uint16_t payload_lens[16];
    static events_t evs;

    rng_state = 0x5EED1234u;
    evs.ok_only = true;
    for (int iter = 0; iter < TK_TEST_ITERS(20000); iter++) {
        size_t n = 0;
        size_t inserted = 0;
        const size_t target = rng() % 3072;
        while (n < target && n + TK_FRAME_MAX_LEN < STREAM_CAP - TK_FRAME_MAX_LEN) {
            const uint32_t pick = rng() % 16;
            if (pick == 0 && inserted < 16) {
                // A real frame, mostly small so several fit.
                const uint16_t len = (uint16_t)((rng() % 8 == 0) ? rng() % (TK_FRAME_MAX_PAYLOAD + 1)
                                                                 : rng() % 64);
                fill_payload(payloads[inserted], len);
                payload_lens[inserted] = len;
                n += encode((uint8_t)rng(), (uint8_t)inserted, payloads[inserted], len, stream + n);
                inserted++;
            } else if (pick < 4) {
                // A fake header: right magic and version, random type/seq/len.
                stream[n++] = TK_FRAME_MAGIC;
                stream[n++] = TK_FRAME_VERSION;
                stream[n++] = (uint8_t)rng();
                stream[n++] = (uint8_t)rng();
                const uint16_t len = (uint16_t)((rng() % 2) ? rng() % 32 : rng());
                stream[n++] = (uint8_t)(len & 0xFF);
                stream[n++] = (uint8_t)(len >> 8);
            } else if (pick < 6) {
                stream[n++] = TK_FRAME_MAGIC;
            } else {
                stream[n++] = (uint8_t)rng();
            }
        }
        // Padding with no magic byte: lets any pending fake frame complete and fail.
        memset(stream + n, 0, TK_FRAME_MAX_LEN);
        n += TK_FRAME_MAX_LEN;

        tk_frame_decoder_t d;
        tk_frame_decoder_init(&d);
        evs.count = 0;
        evs.dropped = 0;
        feed(&d, stream, n, 0, &evs);

        // Real frames appear in order among the OK events (extra OKs from random garbage
        // would need a 1-in-2^32 CRC match and are allowed by this check).
        size_t next = 0;
        for (size_t i = 0; i < evs.count && next < inserted; i++) {
            const event_t *e = &evs.ev[i];
            if (e->result == TK_FRAME_OK && e->seq == next && e->len == payload_lens[next] &&
                memcmp(e->payload, payloads[next], e->len) == 0) {
                next++;
            }
        }
        if (evs.dropped == 0) {
            TK_CHECK(next == inserted);
        }
        if (tk_test_failures > 0) {
            fprintf(stderr, "random stream iteration %d failed\n", iter);
            return;
        }
    }
}

int main(void) {
    rng_state = 0xC0FFEEu;
    test_known_bytes();
    test_encoder_limits();
    test_round_trip();
    test_two_frames_one_chunk();
    test_garbage_prefix();
    test_errors_then_recovery();
    test_truncation();
    test_bit_flips();
    test_random_streams();
    return tk_test_result();
}
