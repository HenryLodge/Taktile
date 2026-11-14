#ifndef TK_CRC32_H
#define TK_CRC32_H

#include <stddef.h>
#include <stdint.h>

// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320), identical to zlib's crc32().
// Start with crc = 0; chain calls to checksum data in pieces.
uint32_t tk_crc32_update(uint32_t crc, const uint8_t *data, size_t len);

static inline uint32_t tk_crc32(const uint8_t *data, size_t len) {
    return tk_crc32_update(0, data, len);
}

#endif
