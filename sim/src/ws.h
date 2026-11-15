// Minimal WebSocket server pieces (RFC 6455) for the simulator. Pure functions, no sockets, so
// they can be unit tested; the socket glue lives in platform.c.
//
// The serial protocol is a byte stream, so message boundaries don't matter: the payloads of
// binary and continuation frames are simply passed on in order.

#ifndef SIM_WS_H
#define SIM_WS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WS_MAX_REQUEST 4096u
#define WS_MAX_PAYLOAD 65536u
#define WS_ACCEPT_LEN 28u // base64 of a SHA-1

// ---- Handshake ----

typedef enum {
    WS_HS_NEED_MORE = 0, // request not complete yet
    WS_HS_OK,            // *resp holds the 101 reply
    WS_HS_BAD_REQUEST,   // *resp holds a 400 reply
    WS_HS_FORBIDDEN,     // *resp holds a 403 reply (Origin not allowed)
} ws_hs_result_t;

// Sec-WebSocket-Accept for a client key: base64(SHA1(key + GUID)). out gets a NUL-terminated string.
void ws_accept_key(const char *key, size_t key_len, char out[WS_ACCEPT_LEN + 1]);

// An Origin header is allowed if absent (non-browser clients) or a local page:
// http(s)://localhost or http(s)://127.0.0.1, with an optional :port.
bool ws_origin_allowed(const char *origin, size_t len);

// Parse an HTTP upgrade request (req[0..len), not NUL-terminated). On a complete request, writes
// the reply to resp (NUL-terminated) and sets *consumed to the request's length.
ws_hs_result_t ws_handshake(const char *req, size_t len, char *resp, size_t cap, size_t *consumed);

// ---- Frames ----

typedef enum {
    WS_NEED_MORE = 0,
    WS_DATA,  // binary or continuation payload: pass on as serial bytes
    WS_PING,  // reply with a pong carrying the same payload
    WS_PONG,  // ignore
    WS_CLOSE, // reply with close, then drop the connection
    WS_ERROR, // protocol violation (unmasked, text, oversized, reserved bits/opcodes): drop
} ws_event_t;

typedef struct {
    uint8_t buf[14 + WS_MAX_PAYLOAD];
    size_t len;
    size_t frame_len; // bytes of buf used by the frame returned last; dropped on the next call
} ws_decoder_t;

void ws_decoder_init(ws_decoder_t *d);

// Append received bytes. Returns how many were taken (fewer than len only if the buffer is full;
// call ws_next() to make room).
size_t ws_feed(ws_decoder_t *d, const uint8_t *in, size_t len);

// The next complete frame. *payload points into the decoder (unmasked) until the next call.
ws_event_t ws_next(ws_decoder_t *d, const uint8_t **payload, size_t *len);

// Encode one unmasked server frame (FIN set). Returns the frame length, or 0 if cap is too small.
size_t ws_encode(uint8_t opcode, const uint8_t *payload, size_t len, uint8_t *out, size_t cap);

#define WS_OP_CONTINUATION 0x0u
#define WS_OP_TEXT 0x1u
#define WS_OP_BINARY 0x2u
#define WS_OP_CLOSE 0x8u
#define WS_OP_PING 0x9u
#define WS_OP_PONG 0xAu

#endif
