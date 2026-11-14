#include "tk_contacts.h"

#include <string.h>

#include "memzero.h"
#include "tk_ata.h"
#include "tk_crc32.h"

static const uint8_t BLOB_MAGIC[4] = {'T', 'K', 'C', '1'};

void tk_contacts_init(tk_contacts_t *c) {
    if (c != NULL) {
        memset(c, 0, sizeof(*c));
    }
}

void tk_contacts_wipe(tk_contacts_t *c) {
    if (c != NULL) {
        memzero(c, sizeof(*c));
    }
}

static int name_char_ok(uint8_t ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ||
           ch == ' ' || ch == '-' || ch == '\'';
}

tk_contacts_result_t tk_contacts_validate_name(const uint8_t *name, size_t len) {
    if (name == NULL || len == 0 || len > TK_CONTACT_NAME_MAX) {
        return TK_CONTACTS_NAME_INVALID;
    }
    // Spaces are silent when a name is spelled, so they may not hide at the ends or double up.
    if (name[0] == ' ' || name[len - 1] == ' ') {
        return TK_CONTACTS_NAME_INVALID;
    }
    for (size_t i = 0; i < len; i++) {
        if (!name_char_ok(name[i]) || (i > 0 && name[i] == ' ' && name[i - 1] == ' ')) {
            return TK_CONTACTS_NAME_INVALID;
        }
    }
    return TK_CONTACTS_OK;
}

static uint8_t lower(uint8_t ch) {
    return (ch >= 'A' && ch <= 'Z') ? (uint8_t)(ch - 'A' + 'a') : ch;
}

static int same_name(const tk_contact_t *e, const uint8_t *name, size_t len) {
    if (e->name_len != len) {
        return 0;
    }
    for (size_t i = 0; i < len; i++) {
        if (lower((uint8_t)e->name[i]) != lower(name[i])) {
            return 0;
        }
    }
    return 1;
}

tk_contacts_result_t tk_contacts_check_add(const tk_contacts_t *c, const uint8_t *name, size_t len,
                                           const uint8_t wallet[TK_PUBKEY_LEN]) {
    if (c == NULL || wallet == NULL || c->count > TK_CONTACTS_MAX) {
        return TK_CONTACTS_BAD_ARG;
    }
    const tk_contacts_result_t r = tk_contacts_validate_name(name, len);
    if (r != TK_CONTACTS_OK) {
        return r;
    }
    if (c->count == TK_CONTACTS_MAX) {
        return TK_CONTACTS_FULL;
    }
    for (size_t i = 0; i < c->count; i++) {
        if (same_name(&c->items[i], name, len)) {
            return TK_CONTACTS_NAME_EXISTS;
        }
        if (memcmp(c->items[i].wallet, wallet, TK_PUBKEY_LEN) == 0) {
            return TK_CONTACTS_ADDRESS_EXISTS;
        }
    }
    return TK_CONTACTS_OK;
}

tk_contacts_result_t tk_contacts_add(tk_contacts_t *c, const uint8_t *name, size_t len,
                                     const uint8_t wallet[TK_PUBKEY_LEN]) {
    const tk_contacts_result_t r = tk_contacts_check_add(c, name, len, wallet);
    if (r != TK_CONTACTS_OK) {
        return r;
    }
    tk_contact_t e;
    memset(&e, 0, sizeof(e));
    uint8_t bump = 0;
    if (!tk_ata_derive(wallet, TK_DEVNET_USDC_MINT, e.usdc_ata, &bump)) {
        return TK_CONTACTS_ATA_FAILED;
    }
    e.name_len = (uint8_t)len;
    memcpy(e.name, name, len);
    memcpy(e.wallet, wallet, TK_PUBKEY_LEN);
    c->items[c->count++] = e;
    return TK_CONTACTS_OK;
}

tk_contacts_result_t tk_contacts_remove(tk_contacts_t *c, uint8_t index) {
    if (c == NULL || c->count > TK_CONTACTS_MAX) {
        return TK_CONTACTS_BAD_ARG;
    }
    if (index >= c->count) {
        return TK_CONTACTS_NOT_FOUND;
    }
    for (size_t i = index; i + 1 < c->count; i++) {
        c->items[i] = c->items[i + 1];
    }
    c->count--;
    memzero(&c->items[c->count], sizeof(c->items[c->count]));
    return TK_CONTACTS_OK;
}

const tk_contact_t *tk_contacts_get(const tk_contacts_t *c, uint8_t index) {
    if (c == NULL || index >= c->count || index >= TK_CONTACTS_MAX) {
        return NULL;
    }
    return &c->items[index];
}

int tk_contacts_find(const tk_contacts_t *c, tk_tx_kind_t kind, const uint8_t dest[TK_PUBKEY_LEN]) {
    if (c == NULL || dest == NULL || (kind != TK_TX_SOL && kind != TK_TX_USDC)) {
        return -1;
    }
    const size_t n = c->count <= TK_CONTACTS_MAX ? c->count : TK_CONTACTS_MAX;
    for (size_t i = 0; i < n; i++) {
        const uint8_t *key = kind == TK_TX_SOL ? c->items[i].wallet : c->items[i].usdc_ata;
        if (memcmp(key, dest, TK_PUBKEY_LEN) == 0) {
            return (int)i;
        }
    }
    return -1;
}

tk_status_t tk_contacts_status(tk_contacts_result_t r) {
    switch (r) {
    case TK_CONTACTS_OK:
        return TK_STATUS_OK;
    case TK_CONTACTS_FULL:
        return TK_STATUS_CONTACTS_FULL;
    case TK_CONTACTS_NAME_EXISTS:
    case TK_CONTACTS_ADDRESS_EXISTS:
        return TK_STATUS_CONTACT_EXISTS;
    case TK_CONTACTS_NOT_FOUND:
        return TK_STATUS_NOT_FOUND;
    default:
        return TK_STATUS_PARSE_UNSUPPORTED;
    }
}

static void put_u32_le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

size_t tk_contacts_save(const tk_contacts_t *c, uint8_t *out, size_t cap) {
    if (c == NULL || out == NULL || cap < TK_CONTACTS_BLOB_LEN || c->count > TK_CONTACTS_MAX) {
        return 0;
    }
    memset(out, 0, TK_CONTACTS_BLOB_LEN);
    memcpy(out, BLOB_MAGIC, sizeof(BLOB_MAGIC));
    out[4] = c->count;
    for (size_t i = 0; i < c->count; i++) {
        uint8_t *slot = out + 5 + i * TK_CONTACTS_SLOT_LEN;
        slot[0] = c->items[i].name_len;
        memcpy(slot + 1, c->items[i].name, c->items[i].name_len);
        memcpy(slot + 1 + TK_CONTACT_NAME_MAX, c->items[i].wallet, TK_PUBKEY_LEN);
    }
    const size_t body = TK_CONTACTS_BLOB_LEN - 4;
    put_u32_le(out + body, tk_crc32(out, body));
    return TK_CONTACTS_BLOB_LEN;
}

static tk_contacts_result_t load(tk_contacts_t *c, const uint8_t *blob, size_t len) {
    if (blob == NULL || len != TK_CONTACTS_BLOB_LEN || memcmp(blob, BLOB_MAGIC, sizeof(BLOB_MAGIC)) != 0) {
        return TK_CONTACTS_BAD_BLOB;
    }
    const size_t body = TK_CONTACTS_BLOB_LEN - 4;
    const uint8_t *crc = blob + body;
    const uint32_t want = (uint32_t)crc[0] | ((uint32_t)crc[1] << 8) | ((uint32_t)crc[2] << 16) |
                          ((uint32_t)crc[3] << 24);
    if (tk_crc32(blob, body) != want || blob[4] > TK_CONTACTS_MAX) {
        return TK_CONTACTS_BAD_BLOB;
    }
    const uint8_t count = blob[4];
    for (size_t i = 0; i < TK_CONTACTS_MAX; i++) {
        const uint8_t *slot = blob + 5 + i * TK_CONTACTS_SLOT_LEN;
        if (i >= count) {
            // Unused slots must be all zero, so a saved table has exactly one encoding.
            for (size_t b = 0; b < TK_CONTACTS_SLOT_LEN; b++) {
                if (slot[b] != 0) {
                    return TK_CONTACTS_BAD_BLOB;
                }
            }
            continue;
        }
        const uint8_t name_len = slot[0];
        if (name_len > TK_CONTACT_NAME_MAX) {
            return TK_CONTACTS_BAD_BLOB;
        }
        for (size_t b = 1u + name_len; b <= TK_CONTACT_NAME_MAX; b++) {
            if (slot[b] != 0) {
                return TK_CONTACTS_BAD_BLOB;
            }
        }
        // Re-run every add() rule, including duplicates against the entries loaded so far.
        if (tk_contacts_add(c, slot + 1, name_len, slot + 1 + TK_CONTACT_NAME_MAX) != TK_CONTACTS_OK) {
            return TK_CONTACTS_BAD_BLOB;
        }
    }
    return TK_CONTACTS_OK;
}

tk_contacts_result_t tk_contacts_load(tk_contacts_t *c, const uint8_t *blob, size_t len) {
    if (c == NULL) {
        return TK_CONTACTS_BAD_ARG;
    }
    tk_contacts_init(c);
    const tk_contacts_result_t r = load(c, blob, len);
    if (r != TK_CONTACTS_OK) {
        tk_contacts_wipe(c);
    }
    return r;
}
