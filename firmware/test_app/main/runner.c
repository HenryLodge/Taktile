// Runs every core/ test on the device, in the order of core/tests/tests.cmake, and prints one line
// per test plus a summary that firmware/tools/device_tests.py waits for. Runs (short) at boot, again
// on any key: 'f' for a full run, anything else for a short one. Never shipped; holds no key.

#include <stdbool.h>
#include <stdio.h>

#include "bootloader_random.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TK_TEST(name) int tk_test_##name(void);
#include "tk_test_list.h"
#undef TK_TEST

typedef struct {
    const char *name;
    int (*run)(void);
} test_t;

static const test_t TESTS[] = {
#define TK_TEST(name) {#name, tk_test_##name},
#include "tk_test_list.h"
#undef TK_TEST
};

#define N_TESTS (sizeof(TESTS) / sizeof(TESTS[0]))

// TK_TEST_ITERS divisor (core/tests/tk_test.h). Short run: 1/20 of the seeded random iterations,
// a few minutes. Full run: the host's counts, about 40 minutes (test_proto alone is ~33).
#define SHORT_DIV 20u
unsigned tk_test_iter_div = SHORT_DIV;

static void run_all(bool full) {
    tk_test_iter_div = full ? 1u : SHORT_DIV;
    printf("\nDEVICE TESTS: running %u core/ tests (%s)\n", (unsigned)N_TESTS,
           full ? "full" : "short: random loops at 1/20");
    unsigned failed = 0;
    const int64_t start = esp_timer_get_time();
    for (size_t i = 0; i < N_TESTS; i++) {
        printf("TEST %s ...\n", TESTS[i].name);
        const int64_t t0 = esp_timer_get_time();
        const int rc = TESTS[i].run(); // the test prints "OK" or its failed checks itself
        const long long ms = (esp_timer_get_time() - t0) / 1000;
        printf("TEST %s %s (%lld ms)\n", TESTS[i].name, rc == 0 ? "PASS" : "FAIL", ms);
        failed += rc != 0;
        vTaskDelay(1); // let the idle task run between tests
    }
    const long long total = (esp_timer_get_time() - start) / 1000;
    if (failed == 0) {
        printf("DEVICE TESTS: %u/%u PASS in %lld ms\n", (unsigned)N_TESTS, (unsigned)N_TESTS, total);
    } else {
        printf("DEVICE TESTS: %u of %u FAILED in %lld ms\n", failed, (unsigned)N_TESTS, total);
    }
}

void app_main(void) {
    bootloader_random_enable(); // same first statement as the product firmware (I11)

    // Console through the USB driver: blocking writes (nothing dropped) and reads for the rerun key.
    usb_serial_jtag_driver_config_t cfg = {.tx_buffer_size = 4096, .rx_buffer_size = 256};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    usb_serial_jtag_vfs_use_driver();
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    run_all(false);
    for (;;) {
        uint8_t c;
        if (usb_serial_jtag_read_bytes(&c, 1, portMAX_DELAY) == 1) {
            run_all(c == 'f'); // 'f': full run; any other key: short run
        }
    }
}
