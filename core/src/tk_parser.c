#include "tk_parser.h"

#include <string.h>

#define TK_SYSTEM_TRANSFER 2u
#define TK_TOKEN_TRANSFER_CHECKED 12u
#define TK_SOL_DATA_LEN 12u
#define TK_TOKEN_DATA_LEN 10u

tk_parse_result_t tk_compact_u16_read(const uint8_t *p, size_t avail, uint16_t *value, size_t *used) {
    uint32_t v = 0;
    for (size_t i = 0; i < 3; i++) {
        if (i >= avail) {
            return TK_PARSE_TRUNCATED;
        }
        const uint8_t b = p[i];
        if (i == 2 && b > 0x03u) {
            return TK_PARSE_BAD_COMPACT_U16; // overflow past 16 bits, or a continuation bit
        }
        v |= (uint32_t)(b & 0x7Fu) << (7u * i);
        if ((b & 0x80u) == 0) {
            if (i > 0 && b == 0) {
                return TK_PARSE_BAD_COMPACT_U16; // alias: a shorter encoding exists
            }
            *value = (uint16_t)v;
            *used = i + 1;
            return TK_PARSE_OK;
        }
    }
    return TK_PARSE_BAD_COMPACT_U16; // unreachable: byte 3 is checked above
}

tk_status_t tk_parse_status(tk_parse_result_t r) {
    return r == TK_PARSE_OK ? TK_STATUS_OK : TK_STATUS_PARSE_UNSUPPORTED;
}

typedef struct {
    const uint8_t *p;
    size_t len;
    size_t pos;
} cursor_t;

static size_t remaining(const cursor_t *c) {
    return c->len - c->pos;
}

// Advance by n bytes, returning a pointer to them, or NULL if fewer than n remain.
static const uint8_t *take(cursor_t *c, size_t n) {
    if (n > remaining(c)) {
        return NULL;
    }
    const uint8_t *at = c->p + c->pos;
    c->pos += n;
    return at;
}

static tk_parse_result_t take_compact(cursor_t *c, uint16_t *value) {
    size_t used = 0;
    const tk_parse_result_t r = tk_compact_u16_read(c->p + c->pos, remaining(c), value, &used);
    if (r == TK_PARSE_OK) {
        c->pos += used;
    }
    return r;
}

static uint64_t read_u64_le(const uint8_t *p) {
    uint64_t v = 0;
    for (size_t i = 0; i < 8; i++) {
        v |= (uint64_t)p[i] << (8u * i);
    }
    return v;
}

static uint32_t read_u32_le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int key_eq(const uint8_t *a, const uint8_t *b) {
    return memcmp(a, b, TK_PUBKEY_LEN) == 0;
}

// The structurally valid pieces of a message. All pointers point into the caller's buffer.
typedef struct {
    uint8_t num_signatures;
    uint8_t num_readonly_signed;
    uint8_t num_readonly_unsigned;
    uint16_t num_keys;
    const uint8_t *keys; // num_keys * 32 bytes
    uint16_t num_instructions;
    // first instruction
    uint8_t program_index;
    uint16_t num_accounts;
    const uint8_t *accounts; // num_accounts bytes
    uint16_t data_len;
    const uint8_t *data; // data_len bytes
} message_t;

static const uint8_t *key_at(const message_t *m, size_t i) {
    return m->keys + i * TK_PUBKEY_LEN;
}

static tk_parse_result_t parse_structure(const uint8_t *msg, size_t len, message_t *m) {
    cursor_t c = {msg, len, 0};
    tk_parse_result_t r;

    const uint8_t *hdr = take(&c, 3);
    if (hdr == NULL) {
        return TK_PARSE_TRUNCATED;
    }
    m->num_signatures = hdr[0];
    m->num_readonly_signed = hdr[1];
    m->num_readonly_unsigned = hdr[2];

    if ((r = take_compact(&c, &m->num_keys)) != TK_PARSE_OK) {
        return r;
    }
    // num_keys <= 0xFFFF, so the product cannot overflow size_t.
    if ((m->keys = take(&c, (size_t)m->num_keys * TK_PUBKEY_LEN)) == NULL) {
        return TK_PARSE_TRUNCATED;
    }
    if (take(&c, 32) == NULL) { // recent_blockhash: not inspected
        return TK_PARSE_TRUNCATED;
    }
    if ((r = take_compact(&c, &m->num_instructions)) != TK_PARSE_OK) {
        return r;
    }

    // Walk every instruction so truncation and trailing bytes are always detected; keep the first.
    for (uint32_t i = 0; i < m->num_instructions; i++) {
        const uint8_t *prog = take(&c, 1);
        if (prog == NULL) {
            return TK_PARSE_TRUNCATED;
        }
        uint16_t k = 0;
        if ((r = take_compact(&c, &k)) != TK_PARSE_OK) {
            return r;
        }
        const uint8_t *accounts = take(&c, k);
        if (accounts == NULL) {
            return TK_PARSE_TRUNCATED;
        }
        uint16_t l = 0;
        if ((r = take_compact(&c, &l)) != TK_PARSE_OK) {
            return r;
        }
        const uint8_t *data = take(&c, l);
        if (data == NULL) {
            return TK_PARSE_TRUNCATED;
        }
        if (i == 0) {
            m->program_index = *prog;
            m->num_accounts = k;
            m->accounts = accounts;
            m->data_len = l;
            m->data = data;
        }
    }

    return remaining(&c) == 0 ? TK_PARSE_OK : TK_PARSE_TRAILING_BYTES;
}

static tk_parse_result_t check_common(const message_t *m, const uint8_t *device) {
    // Implies num_keys >= 1, so key_at(m, 0) below is in bounds.
    if (m->num_signatures != 1 || m->num_readonly_signed != 0 ||
        m->num_readonly_unsigned >= m->num_keys) {
        return TK_PARSE_BAD_HEADER;
    }
    if (!key_eq(key_at(m, 0), device)) {
        return TK_PARSE_FEE_PAYER;
    }
    for (size_t i = 0; i < m->num_keys; i++) {
        for (size_t j = i + 1; j < m->num_keys; j++) {
            if (key_eq(key_at(m, i), key_at(m, j))) {
                return TK_PARSE_DUPLICATE_KEY;
            }
        }
    }
    if (m->num_instructions != 1) {
        return TK_PARSE_INSTRUCTION_COUNT;
    }
    if (m->program_index >= m->num_keys) {
        return TK_PARSE_INDEX_OUT_OF_RANGE;
    }
    for (size_t i = 0; i < m->num_accounts; i++) {
        if (m->accounts[i] >= m->num_keys) {
            return TK_PARSE_INDEX_OUT_OF_RANGE;
        }
    }
    return TK_PARSE_OK;
}

// Shape A. accounts = [from, to]; data = u32 LE 2, u64 LE lamports.
static tk_parse_result_t parse_sol(const message_t *m, const uint8_t *device, tk_tx_t *out) {
    if (m->num_accounts != 2 || m->data_len != TK_SOL_DATA_LEN ||
        read_u32_le(m->data) != TK_SYSTEM_TRANSFER) {
        return TK_PARSE_SOL_LAYOUT;
    }
    if (!key_eq(key_at(m, m->accounts[0]), device)) {
        return TK_PARSE_SOL_FROM_NOT_DEVICE;
    }
    out->kind = TK_TX_SOL;
    out->amount = read_u64_le(m->data + 4);
    memcpy(out->destination, key_at(m, m->accounts[1]), TK_PUBKEY_LEN);
    return TK_PARSE_OK;
}

// Shape B. accounts = [source, mint, destination, owner]; data = 12, u64 LE amount, u8 decimals.
static tk_parse_result_t parse_usdc(const message_t *m, const uint8_t *device,
                                    const uint8_t *device_usdc_ata, tk_tx_t *out) {
    if (m->num_accounts != 4 || m->data_len != TK_TOKEN_DATA_LEN ||
        m->data[0] != TK_TOKEN_TRANSFER_CHECKED) {
        return TK_PARSE_TOKEN_LAYOUT;
    }
    if (!key_eq(key_at(m, m->accounts[1]), TK_DEVNET_USDC_MINT)) {
        return TK_PARSE_TOKEN_WRONG_MINT;
    }
    if (m->data[9] != TK_USDC_DECIMALS) {
        return TK_PARSE_TOKEN_WRONG_DECIMALS;
    }
    if (!key_eq(key_at(m, m->accounts[0]), device_usdc_ata)) {
        return TK_PARSE_TOKEN_WRONG_SOURCE;
    }
    if (!key_eq(key_at(m, m->accounts[3]), device)) {
        return TK_PARSE_TOKEN_OWNER_NOT_DEVICE;
    }
    out->kind = TK_TX_USDC;
    out->amount = read_u64_le(m->data + 1);
    memcpy(out->destination, key_at(m, m->accounts[2]), TK_PUBKEY_LEN);
    return TK_PARSE_OK;
}

static tk_parse_result_t parse(const uint8_t *msg, size_t len, const uint8_t *device,
                               const uint8_t *device_usdc_ata, tk_tx_t *out) {
    if (len > TK_MAX_MESSAGE_LEN) {
        return TK_PARSE_TOO_LARGE;
    }
    if (len == 0) {
        return TK_PARSE_TRUNCATED;
    }
    if ((msg[0] & 0x80u) != 0) {
        return TK_PARSE_VERSIONED;
    }

    message_t m;
    memset(&m, 0, sizeof(m));
    tk_parse_result_t r = parse_structure(msg, len, &m);
    if (r != TK_PARSE_OK) {
        return r;
    }
    if ((r = check_common(&m, device)) != TK_PARSE_OK) {
        return r;
    }

    const uint8_t *program = key_at(&m, m.program_index);
    if (key_eq(program, TK_SYSTEM_PROGRAM_ID)) {
        return parse_sol(&m, device, out);
    }
    if (key_eq(program, TK_TOKEN_PROGRAM_ID)) {
        return parse_usdc(&m, device, device_usdc_ata, out);
    }
    return TK_PARSE_UNSUPPORTED_PROGRAM;
}

tk_parse_result_t tk_parse_message(const uint8_t *msg, size_t len,
                                   const uint8_t device_pubkey[TK_PUBKEY_LEN],
                                   const uint8_t device_usdc_ata[TK_PUBKEY_LEN], tk_tx_t *out) {
    memset(out, 0, sizeof(*out));
    if ((msg == NULL && len > 0) || device_pubkey == NULL || device_usdc_ata == NULL) {
        return TK_PARSE_TRUNCATED;
    }
    const tk_parse_result_t r = parse(msg, len, device_pubkey, device_usdc_ata, out);
    if (r != TK_PARSE_OK) {
        memset(out, 0, sizeof(*out));
    }
    return r;
}
