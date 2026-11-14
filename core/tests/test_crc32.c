#include "tk_crc32.h"
#include "tk_test.h"

int main(void) {
    const uint8_t check[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};

    // Standard CRC-32 check value.
    TK_CHECK(tk_crc32(check, sizeof(check)) == 0xCBF43926u);
    TK_CHECK(tk_crc32(NULL, 0) == 0u);

    // Chained updates equal one call.
    for (size_t split = 0; split <= sizeof(check); split++) {
        uint32_t crc = tk_crc32_update(0, check, split);
        crc = tk_crc32_update(crc, check + split, sizeof(check) - split);
        TK_CHECK(crc == 0xCBF43926u);
    }

    return tk_test_result();
}
