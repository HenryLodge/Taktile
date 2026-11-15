// The device's request handling: serial protocol dispatch plus the SIGN_REQUEST flow
// (announce -> PIN -> confirm -> sign). See docs/ARCHITECTURE.md and docs/SERIAL_PROTOCOL.md.
//
// Single-threaded. The platform's main loop calls tk_device_poll() repeatedly. A SIGN_REQUEST runs
// its whole flow inside that call; while it runs, the device keeps reading the serial link between
// clips and between short button-wait slices, and answers other requests (decision 8):
//   - HELLO is answered normally;
//   - CANCEL gets OK and ends the flow (the SIGN_REQUEST then gets CANCELLED);
//   - anything else gets BUSY, with its own seq.
// EVENT frames carry the SIGN_REQUEST's seq. The device never checks seq order.

#ifndef TK_DEVICE_H
#define TK_DEVICE_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_contacts.h"
#include "tk_parser.h"
#include "tk_pin_entry.h"
#include "tk_platform.h"
#include "tk_proto.h"
#include "tk_wallet.h"

#define TK_FW_VERSION 0x0001u
#define TK_PROTO_VERSION 0x01u

#define TK_CONFIRM_TIMEOUT_MS 30000u // I6
#define TK_WAIT_SLICE_MS 100u        // longest gap between serial checks while waiting for a button

// HELLO state byte
#define TK_STATE_NO_WALLET 0u
#define TK_STATE_LOCKED 1u
#define TK_STATE_UNLOCKED 2u

// Storage key for the saved contact book (tk_contacts_save).
#define TK_STORAGE_CONTACTS "contacts"

typedef struct {
    const tk_platform_t *platform;
    const tk_wallet_ops_t *wallet;
    tk_contacts_t *contacts;

    tk_frame_decoder_t decoder;
    uint8_t rx[256];
    size_t rx_len, rx_pos;
    uint8_t tx[TK_FRAME_MAX_LEN];

    bool keys_ready; // pubkey and usdc_ata below are valid
    uint8_t pubkey[TK_PUBKEY_LEN];
    uint8_t usdc_ata[TK_PUBKEY_LEN];

    bool in_flow;
    uint8_t flow_seq;
    bool cancel; // host CANCEL received during the current flow
    uint8_t msg[TK_MAX_MESSAGE_LEN];
    tk_ui_t ui;
} tk_device_t;

void tk_device_init(tk_device_t *d, const tk_platform_t *platform, const tk_wallet_ops_t *wallet,
                    tk_contacts_t *contacts);

// Forget any partly received frame and unread bytes (e.g. the sim's WebSocket client changed).
void tk_device_link_reset(tk_device_t *d);

// Read what the serial link has and handle every complete frame. Returns after the input is
// drained (a SIGN_REQUEST's flow runs to completion first).
void tk_device_poll(tk_device_t *d);

#endif
