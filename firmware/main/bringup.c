// Hardware bring-up menu. Built only with CONFIG_TK_BRINGUP (sdkconfig.bringup): the console is on
// the USB port, so use `idf.py monitor`. Never ship this build.

#include "sdkconfig.h"

#if CONFIG_TK_BRINGUP

#include <stdio.h>

#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "bringup.h"
#include "tk_device.h"
#include "tk_pins.h"

static void menu(void) {
    printf("\nTaktile bring-up (fw 0x%04x). Pick a step:\n"
           "  1  blink the red LED + echo what you type\n"
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
    printf("step 1: LED on GPIO%d blinks at 1 Hz; type and each key is echoed.\n", TK_PIN_LED);

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

void tk_bringup_main(void) {
    // The console shares the USB port; route it through the driver so stdout and our raw reads
    // and writes don't fight over the hardware FIFO.
    usb_serial_jtag_driver_config_t cfg = {.tx_buffer_size = 1024, .rx_buffer_size = 1024};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    usb_serial_jtag_vfs_use_driver();
    setvbuf(stdout, NULL, _IONBF, 0);

    menu();
    for (;;) {
        const int c = read_byte(1000);
        switch (c) {
        case -1: break;
        case '1': step_blink_echo(); break; // does not return
        default: menu(); break;
        }
    }
}

#endif
