// USB-Serial-JTAG link. See link.h.

#include "link.h"

#include "driver/usb_serial_jtag.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"

#include "tk_proto.h"

#define LINK_BUF_LEN 4096u   // RX and TX ring buffers; a whole frame fits
#define WRITE_TIMEOUT_MS 50u // per chunk; a host that stops reading loses the rest

_Static_assert(LINK_BUF_LEN >= TK_FRAME_MAX_LEN, "link buffers must hold a whole frame");

static bool pending;     // bytes arrived since the last reset
static uint32_t last_rx; // ms timestamp of the last byte that arrived
static bool was_connected;

static uint32_t ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000);
}

bool tk_link_init(void) {
    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = LINK_BUF_LEN,
        .rx_buffer_size = LINK_BUF_LEN,
    };
    return usb_serial_jtag_driver_install(&cfg) == ESP_OK;
}

size_t tk_link_read(uint8_t *buf, size_t cap) {
    if (cap == 0) {
        return 0;
    }
    const int n = usb_serial_jtag_read_bytes(buf, (uint32_t)cap, 0);
    if (n <= 0) {
        return 0;
    }
    pending = true;
    last_rx = ms();
    return (size_t)n;
}

void tk_link_write(const uint8_t *buf, size_t len) {
    while (len > 0) {
        if (!usb_serial_jtag_is_connected()) {
            return; // no host: dropped, like an unplugged cable
        }
        const int n = usb_serial_jtag_write_bytes(buf, len, pdMS_TO_TICKS(WRITE_TIMEOUT_MS));
        if (n <= 0) {
            return; // the host stopped reading
        }
        buf += n;
        len -= (size_t)n;
    }
}

bool tk_link_host_lost(void) {
    static bool seen;
    const bool connected = usb_serial_jtag_is_connected();
    const bool lost = seen && !connected;
    seen = connected;
    return lost;
}

bool tk_link_should_reset(uint32_t now_ms) {
    const bool connected = usb_serial_jtag_is_connected();
    const bool dropped = was_connected && !connected;
    was_connected = connected;
    if (dropped || (pending && now_ms - last_rx >= TK_LINK_IDLE_RESET_MS)) {
        pending = false;
        return true;
    }
    return false;
}
