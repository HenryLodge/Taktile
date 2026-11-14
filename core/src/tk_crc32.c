#include "tk_crc32.h"

uint32_t tk_crc32_update(uint32_t crc, const uint8_t *data, size_t len) {
    // Bitwise, no lookup table: frames are at most ~2 KB, and this saves 1 KB of flash.
    uint32_t c = ~crc;
    for (size_t i = 0; i < len; i++) {
        c ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
        }
    }
    return ~c;
}
