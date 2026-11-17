// libFuzzer target for the clip pack parser. The input is a whole pack image.
//
// The expected count and fingerprint are taken from the input itself, so the fuzzer gets past those
// checks and into the index. Checked: open never reads outside the input (ASan), and after a
// successful open every clip returned by get lies inside the input, after the index, with an even
// length; a failed open leaves the pack unusable.

#include <stdlib.h>

#include "tk_clippack.h"

#define REQUIRE(cond)    \
    do {                 \
        if (!(cond)) {   \
            abort();     \
        }                \
    } while (0)

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    uint16_t count = 0;
    uint32_t fp = 0;
    if (size >= TK_CLIPPACK_HEADER_LEN) {
        count = (uint16_t)(data[6] | (data[7] << 8));
        fp = (uint32_t)data[12] | ((uint32_t)data[13] << 8) | ((uint32_t)data[14] << 16) |
             ((uint32_t)data[15] << 24);
    }
    tk_clippack_t p;
    const uint8_t *pcm;
    if (tk_clippack_open(&p, data, size, count, fp) != TK_CLIPPACK_OK) {
        REQUIRE(p.buf == NULL);
        REQUIRE(tk_clippack_get(&p, 0, &pcm) == 0 && pcm == NULL);
        return 0;
    }
    REQUIRE(p.len <= size && p.data_start <= p.len);
    (void)tk_clippack_verify_crc(&p);
    for (uint32_t id = 0; id <= p.count; id++) {
        const uint32_t n = tk_clippack_get(&p, (uint16_t)id, &pcm);
        if (id == p.count) {
            REQUIRE(n == 0 && pcm == NULL);
            break;
        }
        REQUIRE(pcm != NULL && (n & 1u) == 0);
        REQUIRE(pcm >= data + p.data_start && pcm + n <= data + p.len);
    }
    return 0;
}
