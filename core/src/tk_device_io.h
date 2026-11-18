// Internal to core/src: the flow I/O that tk_flow.c owns, shared with other on-device flows
// (tk_setup.c). Not part of core's public API (not in include/).

#ifndef TK_DEVICE_IO_H
#define TK_DEVICE_IO_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_device.h"

// Play a clip through the flow I/O: services the serial link before and after, and plays nothing
// once the host has cancelled. secret = private audio (I2).
void tk_dev_play(tk_device_t *d, uint16_t clip, bool secret);
void tk_dev_say(tk_device_t *d, uint16_t clip); // public clip

void tk_dev_send_event(tk_device_t *d, tk_event_t event); // with the current flow's seq

// Load the wallet's public key and derive its USDC ATA once. False if there is no usable wallet.
bool tk_dev_ensure_keys(tk_device_t *d);

#endif
