// libFuzzer target for the streaming frame decoder. The input is a raw byte stream.
//
// The stream is decoded twice: in one feed, and in chunks whose sizes come from a PRNG seeded by
// the input. The serial link delivers bytes in arbitrary pieces, so both runs must report the
// same events. Also checked: consumed <= given, the decoder always makes progress, every OK
// frame re-encodes and decodes back to itself, and the input wrapped in a valid frame decodes to
// exactly that frame.

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "tk_crc32.h"
#include "tk_proto.h"

#define REQUIRE(cond)    \
    do {                 \
        if (!(cond)) {   \
            abort();     \
        }                \
    } while (0)

#define MAX_EVENTS 4096u

typedef struct {
    tk_frame_result_t result;
    uint8_t type;
    uint8_t seq;
    bool seq_valid;
    uint16_t len;
    uint32_t payload_crc;
} event_t;

static event_t events_whole[MAX_EVENTS];
static event_t events_chunked[MAX_EVENTS];

static void check_roundtrip(const tk_frame_t *f) {
    static uint8_t buf[TK_FRAME_MAX_LEN];
    static tk_frame_decoder_t d;
    size_t n = 0;
    REQUIRE(tk_frame_encode(f->type, f->seq, f->payload, f->len, buf, sizeof(buf), &n) == TK_FRAME_ENC_OK);
    tk_frame_decoder_init(&d);
    size_t used = 0;
    tk_frame_t g;
    REQUIRE(tk_frame_decoder_feed(&d, buf, n, &used, &g) == TK_FRAME_OK);
    REQUIRE(used == n);
    REQUIRE(g.type == f->type && g.seq == f->seq && g.len == f->len);
    REQUIRE(g.len == 0 || memcmp(g.payload, f->payload, g.len) == 0);
}

// Returns the number of events (only the first MAX_EVENTS are stored).
static size_t run(const uint8_t *data, size_t size, bool chunked, event_t *events) {
    static tk_frame_decoder_t d;
    tk_frame_decoder_init(&d);
    uint32_t x = tk_crc32(data, size) | 1u;
    size_t pos = 0;
    size_t count = 0;
    size_t calls = 0;
    for (;;) {
        // Each call either consumes everything it was given or reports an event, and each event
        // drops at least one buffered byte, so this bounds the loop.
        REQUIRE(++calls <= 2 * size + 64);
        const size_t avail = size - pos;
        size_t give = avail;
        if (chunked && avail > 0) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            const size_t max = avail < 300 ? avail : 300;
            give = 1 + (size_t)(x % max);
        }
        size_t used = 0;
        tk_frame_t f;
        const tk_frame_result_t r = tk_frame_decoder_feed(&d, data + pos, give, &used, &f);
        REQUIRE(used <= give);
        pos += used;
        if (r == TK_FRAME_NEED_MORE) {
            REQUIRE(used == give);
            if (pos == size) {
                return count;
            }
            continue;
        }
        REQUIRE(r == TK_FRAME_OK || r == TK_FRAME_BAD_FRAME || r == TK_FRAME_TOO_LARGE);
        REQUIRE(f.seq_valid);
        event_t e = {r, f.type, f.seq, f.seq_valid, 0, 0};
        if (r == TK_FRAME_OK) {
            REQUIRE(f.len <= TK_FRAME_MAX_PAYLOAD);
            REQUIRE(f.len == 0 || f.payload != NULL);
            e.len = f.len;
            e.payload_crc = tk_crc32(f.payload, f.len);
            check_roundtrip(&f); // before the next feed: f.payload points into the decoder
        }
        if (count < MAX_EVENTS) {
            events[count] = e;
        }
        count++;
    }
}

static bool same_event(const event_t *a, const event_t *b) {
    return a->result == b->result && a->type == b->type && a->seq == b->seq &&
           a->seq_valid == b->seq_valid && a->len == b->len && a->payload_crc == b->payload_crc;
}

// Random bytes almost never carry a correct CRC, so the stream runs above rarely reach the OK
// path. Also wrap the input in a valid frame: it must decode, in chunks, to exactly that frame.
static void check_valid_frame(const uint8_t *data, size_t size) {
    static uint8_t buf[TK_FRAME_MAX_LEN];
    if (size > TK_FRAME_MAX_PAYLOAD) {
        return;
    }
    const uint8_t type = size > 0 ? data[0] : 0;
    const uint8_t seq = size > 1 ? data[1] : 0;
    size_t n = 0;
    REQUIRE(tk_frame_encode(type, seq, data, size, buf, sizeof(buf), &n) == TK_FRAME_ENC_OK);
    REQUIRE(n == TK_FRAME_HEADER_LEN + size + TK_FRAME_CRC_LEN);
    const size_t count = run(buf, n, true, events_chunked);
    REQUIRE(count == 1);
    const event_t *e = &events_chunked[0];
    REQUIRE(e->result == TK_FRAME_OK && e->type == type && e->seq == seq && e->len == size);
    REQUIRE(e->payload_crc == tk_crc32(data, size));
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    check_valid_frame(data, size);

    const size_t n_whole = run(data, size, false, events_whole);
    const size_t n_chunked = run(data, size, true, events_chunked);
    REQUIRE(n_whole == n_chunked);
    const size_t n = n_whole < MAX_EVENTS ? n_whole : MAX_EVENTS;
    for (size_t i = 0; i < n; i++) {
        REQUIRE(same_event(&events_whole[i], &events_chunked[i]));
    }
    return 0;
}
