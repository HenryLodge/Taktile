// The serial link to the laptop: the ESP32-S3's built-in USB-Serial-JTAG (CDC-ACM to the host).
// docs/SERIAL_PROTOCOL.md. In the protocol build the console is off, so only frames cross it.

#ifndef TK_LINK_H
#define TK_LINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TK_LINK_IDLE_RESET_MS 1000u // drop a half-received frame after this much silence

bool tk_link_init(void);

// Never blocks: copies what has arrived (up to cap) and returns the count, 0 if nothing.
size_t tk_link_read(uint8_t *buf, size_t cap);

// Sends everything, or drops the rest if no host is attached or the host stops reading.
void tk_link_write(const uint8_t *buf, size_t len);

// True once per event that should reset core's frame decoder: TK_LINK_IDLE_RESET_MS of silence
// after bytes arrived, or the USB host going away.
bool tk_link_should_reset(uint32_t now_ms);

// True once after the USB host went away (it was connected and then was not), including a loss seen
// only during a flow (tk_link_read samples it too). The main loop then ends any unlocked session
// (tk_device_lock). Closing the serial port on the laptop is not a host loss: the cable and USB
// connection stay up.
bool tk_link_host_lost(void);

#endif
