// Hardware bring-up menu. Built only with CONFIG_TK_BRINGUP (sdkconfig.bringup): the console is on
// the USB port, so use `idf.py monitor`. Never ship this build.

#include "sdkconfig.h"

#if CONFIG_TK_BRINGUP

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bringup.h"
#include "rng.h"
#include "tk_device.h"
#include "tk_pins.h"

// Formats and writes straight to the USB-Serial-JTAG driver. Deliberately not printf/stdout: that
// needs the vfs component, which drags the UART and PSRAM drivers into the build.
__attribute__((format(printf, 1, 2))) static void out(const char *fmt, ...) {
    char line[256];
    va_list ap;
    va_start(ap, fmt);
    const int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n > 0) {
        const size_t len = (size_t)n < sizeof(line) ? (size_t)n : sizeof(line) - 1;
        usb_serial_jtag_write_bytes(line, len, pdMS_TO_TICKS(100));
    }
}

static void menu(void) {
    out("\nTaktile bring-up (fw 0x%04x). Pick a step:\n"
        "  1  blink the red LED + echo what you type\n"
        "  2  RNG: health check + sample\n"
        "Reset the board to come back here.\n",
        TK_FW_VERSION);
}

// Reads one byte, waiting up to timeout_ms. Returns -1 on timeout.
static int read_byte(uint32_t timeout_ms) {
    uint8_t c;
    return usb_serial_jtag_read_bytes(&c, 1, pdMS_TO_TICKS(timeout_ms)) == 1 ? c : -1;
}

// Step 1 (HARDWARE.md bring-up 1): LED toggles every 500 ms; every byte typed comes straight back.
static void step_blink_echo(void) {
    const gpio_config_t led = {
        .pin_bit_mask = 1ULL << TK_PIN_LED,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&led));
    out("step 1: LED on GPIO%d blinks at 1 Hz; type and each key is echoed.\n", TK_PIN_LED);

    int level = 0;
    int64_t next = esp_timer_get_time();
    uint8_t buf[64];
    for (;;) {
        if (esp_timer_get_time() >= next) {
            level = !level;
            gpio_set_level(TK_PIN_LED, (uint32_t)level);
            next += 500 * 1000;
        }
        const int n = usb_serial_jtag_read_bytes(buf, sizeof(buf), pdMS_TO_TICKS(10));
        if (n > 0) {
            usb_serial_jtag_write_bytes(buf, (size_t)n, pdMS_TO_TICKS(50));
        }
    }
}

// Step 2 (HARDWARE.md bring-up 2): entropy source state, a sample, and rough statistics over 64 KB.
// The bytes drawn here are thrown away; this build never holds a key.
static void step_rng(void) {
    const tk_rng_status_t st = tk_rng_status();
    out("step 2: entropy source %s, startup test %s, continuous test %s\n",
        st.entropy_on ? "ON" : "OFF", st.startup_ok ? "PASS" : "FAIL",
        st.cont_failed ? "TRIPPED" : "ok");

    uint8_t sample[32];
    if (!tk_rng_fill(sample, sizeof(sample))) {
        out("RNG REFUSED (fail closed)\nstep 2: FAIL\n");
        return;
    }
    out("sample: ");
    for (size_t i = 0; i < sizeof(sample); i++) {
        out("%02x", sample[i]);
    }
    out("\n");

    enum { TOTAL = 64 * 1024 };
    static uint32_t hist[256];
    memset(hist, 0, sizeof(hist));
    uint8_t buf[256];
    uint32_t ones = 0, run = 1, longest = 1;
    int prev = -1;
    const int64_t t0 = esp_timer_get_time();
    for (size_t done = 0; done < TOTAL; done += sizeof(buf)) {
        if (!tk_rng_fill(buf, sizeof(buf))) {
            out("RNG REFUSED during the run (continuous test tripped)\nstep 2: FAIL\n");
            return;
        }
        for (size_t i = 0; i < sizeof(buf); i++) {
            hist[buf[i]]++;
            ones += (uint32_t)__builtin_popcount(buf[i]);
            run = (buf[i] == prev) ? run + 1 : 1;
            longest = run > longest ? run : longest;
            prev = buf[i];
        }
    }
    const int64_t us = esp_timer_get_time() - t0;

    double chi = 0;
    const double expect = TOTAL / 256.0;
    for (int i = 0; i < 256; i++) {
        const double d = (double)hist[i] - expect;
        chi += d * d / expect;
    }
    const double frac = ones / (TOTAL * 8.0);
    const bool ok = frac > 0.49 && frac < 0.51 && chi < 330 && longest <= 4;
    out("64 KB: ones %.4f (want 0.49-0.51), chi-square %.1f (want ~255, < 330), longest run %u "
        "(want <= 4), %lld KB/s\n",
        frac, chi, (unsigned)longest, (long long)(TOTAL / 1024 * 1000000LL / (us ? us : 1)));
    out("step 2: %s\n", ok ? "PASS" : "FAIL");
}

void tk_bringup_main(void) {
    // From here on, all output goes through the driver (out() and the raw reads and writes), so
    // nothing fights over the hardware FIFO. Only the boot log before this point uses the ROM path.
    usb_serial_jtag_driver_config_t cfg = {.tx_buffer_size = 1024, .rx_buffer_size = 1024};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));

    menu();
    for (;;) {
        const int c = read_byte(1000);
        switch (c) {
        case -1: break;
        case '1': step_blink_echo(); break; // does not return
        case '2': step_rng(); break;
        default: menu(); break;
        }
    }
}

#endif
