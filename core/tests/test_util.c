#include "tk_test.h"
#include "tk_util.h"

int main(void) {
    const uint8_t a[4] = {1, 2, 3, 4};
    const uint8_t b[4] = {1, 2, 3, 4};
    const uint8_t first[4] = {0, 2, 3, 4};
    const uint8_t last[4] = {1, 2, 3, 5};

    TK_CHECK(tk_ct_equal(a, b, sizeof(a)));
    TK_CHECK(!tk_ct_equal(a, first, sizeof(a)));
    TK_CHECK(!tk_ct_equal(a, last, sizeof(a)));
    TK_CHECK(tk_ct_equal(a, first, 0)); // zero length compares equal

    return tk_test_result();
}
