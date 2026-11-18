// Serial protocol v1: constants and framing. See docs/SERIAL_PROTOCOL.md.

#ifndef TK_PROTO_H
#define TK_PROTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TK_FRAME_MAGIC 0xE5u
#define TK_FRAME_VERSION 0x01u
#define TK_FRAME_HEADER_LEN 6u
#define TK_FRAME_CRC_LEN 4u
#define TK_FRAME_MAX_PAYLOAD 2048u
#define TK_FRAME_MAX_LEN (TK_FRAME_HEADER_LEN + TK_FRAME_MAX_PAYLOAD + TK_FRAME_CRC_LEN)

// ---- Message types ----

// A response's type is the request type | TK_MSG_RESPONSE_BIT.
#define TK_MSG_RESPONSE_BIT 0x80u

typedef enum {
    TK_MSG_HELLO = 0x01,
    TK_MSG_GET_PUBKEY = 0x02,
    TK_MSG_SETUP = 0x03,
    TK_MSG_SIGN_REQUEST = 0x10,
    TK_MSG_CONTACT_ADD = 0x30,
    TK_MSG_CONTACT_LIST_COUNT = 0x31,
    TK_MSG_CONTACT_REMOVE = 0x32,
    TK_MSG_CANCEL = 0x7E,
    TK_MSG_EVENT = 0xF0, // device -> host only
    TK_MSG_ERROR = 0xFF, // device -> host only
} tk_msg_type_t;

typedef enum {
    TK_STATUS_OK = 0x00,
    TK_STATUS_REJECTED_BY_USER = 0x01,
    TK_STATUS_UNKNOWN_RECIPIENT = 0x02,
    TK_STATUS_PARSE_UNSUPPORTED = 0x03,
    TK_STATUS_LOCKED_OUT = 0x04,
    TK_STATUS_NO_WALLET = 0x05,
    TK_STATUS_BUSY = 0x06,
    TK_STATUS_CANCELLED = 0x07,
    TK_STATUS_WALLET_EXISTS = 0x08,
    TK_STATUS_CONTACTS_FULL = 0x09,  // CONTACT_ADD: the book already holds 16 contacts
    TK_STATUS_CONTACT_EXISTS = 0x0A, // CONTACT_ADD: same name (ignoring case) or same wallet
    TK_STATUS_NOT_FOUND = 0x0B,      // CONTACT_REMOVE: index >= count
    TK_STATUS_DEVICE_ERROR = 0x0C,   // the device can't do this safely: no audio, RNG, storage or key store
} tk_status_t;

typedef enum {
    TK_EVENT_ANNOUNCING = 0x01,
    TK_EVENT_AWAITING_PIN = 0x02,
    TK_EVENT_AWAITING_CONFIRM = 0x03,
    TK_EVENT_SIGNING = 0x04,
} tk_event_t;

// Payload of an ERROR frame.
typedef enum {
    TK_PROTO_ERR_BAD_FRAME = 0x01,
    TK_PROTO_ERR_UNKNOWN_TYPE = 0x02,
    TK_PROTO_ERR_BAD_PAYLOAD = 0x03,
    TK_PROTO_ERR_TOO_LARGE = 0x04,
} tk_proto_err_code_t;

// ---- Encoder ----

typedef enum {
    TK_FRAME_ENC_OK = 0,
    TK_FRAME_ENC_BAD_ARG,          // NULL out/out_len, or NULL payload with len > 0
    TK_FRAME_ENC_TOO_LARGE,        // len > TK_FRAME_MAX_PAYLOAD
    TK_FRAME_ENC_BUFFER_TOO_SMALL, // out_cap < TK_FRAME_HEADER_LEN + len + TK_FRAME_CRC_LEN
} tk_frame_enc_err_t;

// Writes one complete frame to out. On any error, writes nothing.
tk_frame_enc_err_t tk_frame_encode(uint8_t type, uint8_t seq, const uint8_t *payload, size_t len,
                                   uint8_t *out, size_t out_cap, size_t *out_len);

// ---- Streaming decoder ----

typedef enum {
    TK_FRAME_NEED_MORE = 0, // all input consumed, no complete frame yet
    TK_FRAME_OK,            // *out holds a valid frame
    TK_FRAME_BAD_FRAME,     // bad version or CRC; reply ERROR{BAD_FRAME}
    TK_FRAME_TOO_LARGE,     // header len > TK_FRAME_MAX_PAYLOAD; reply ERROR{TOO_LARGE}
} tk_frame_result_t;

typedef struct {
    uint8_t type;
    uint8_t seq;
    bool seq_valid;         // true when seq came from a header (always, for OK and errors)
    const uint8_t *payload; // OK only: points into the decoder; valid until the next feed/reset
    uint16_t len;           // OK only
} tk_frame_t;

typedef struct {
    uint8_t buf[TK_FRAME_MAX_LEN];
    size_t filled;    // bytes currently buffered
    size_t delivered; // length of the frame returned by the last OK, dropped on the next feed
} tk_frame_decoder_t;

void tk_frame_decoder_init(tk_frame_decoder_t *d);

// Drop any partial frame (e.g. after an idle timeout on the link).
void tk_frame_decoder_reset(tk_frame_decoder_t *d);

// Feed received bytes. Returns at most one event per call and sets *consumed to how many
// input bytes were used. After any result other than NEED_MORE, call again with the remaining
// input (or with len 0 if none is left): bytes already buffered may hold another frame.
//
// Bytes before a magic byte are skipped silently. After an error, scanning resumes at the next
// magic byte inside the rejected bytes, so a real frame that started inside a corrupt one is
// still found.
tk_frame_result_t tk_frame_decoder_feed(tk_frame_decoder_t *d, const uint8_t *data, size_t len,
                                        size_t *consumed, tk_frame_t *out);

#endif
