// The simulator's state: a tk_platform_t for Linux/WSL (terminal keys, printed audio, files for
// storage, a WebSocket for the serial link) and an insecure development wallet.

#ifndef SIM_SIM_H
#define SIM_SIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tk_device.h"
#include "tk_platform.h"
#include "tk_wallet.h"
#include "ws.h"

typedef struct {
    // options
    const char *data_dir;
    unsigned clip_ms;

    // keyboard
    bool stdin_eof;
    uint8_t keybuf[16];
    size_t keylen;

    // WebSocket serial link
    int listen_fd;
    int client_fd; // -1 if none
    bool client_open; // handshake done
    char hs[WS_MAX_REQUEST];
    size_t hs_len;
    ws_decoder_t ws;
    uint8_t in[WS_MAX_PAYLOAD]; // serial bytes received, not yet read by core
    size_t in_len, in_pos;
    uint8_t out[16 + 4096];

    tk_device_t *dev; // for tk_device_link_reset when the client changes
} sim_t;

// Opens the listening socket. Returns false (and prints why) on failure.
bool sim_listen(sim_t *s, const char *addr, unsigned port);

// Accept, read and handshake on the sockets. Called by serial_read and the main loop.
void sim_service_link(sim_t *s);

// Platform callbacks (ctx = sim_t *).
extern const tk_platform_t SIM_PLATFORM_TEMPLATE;

// Read one key without blocking. Returns SIM_KEY_* from util.h.
int sim_read_key(sim_t *s, tk_button_t *button);

void sim_terminal_raw(void);
void sim_terminal_restore(void);

// ---- Development wallet (INSECURE: plaintext seed in the data directory) ----

typedef struct {
    sim_t *sim;
    const tk_platform_t *platform;
    bool has_wallet;
    bool persist; // seed lives in <data>/dev-seed (false with --seed-hex)
    bool unlocked;
    uint8_t seed[32];
    uint8_t pubkey[32];
    uint8_t pin[TK_PIN_LEN];
    uint8_t failures;
} sim_wallet_t;

#define SIM_MAX_PIN_FAILURES 10u

// seed_hex NULL: load <data>/dev-seed, creating it from the RNG on first run.
bool sim_wallet_init(sim_wallet_t *w, const tk_platform_t *p, const char *seed_hex, const char *pin, bool unlocked);
extern const tk_wallet_ops_t SIM_WALLET_OPS_TEMPLATE;

#endif
