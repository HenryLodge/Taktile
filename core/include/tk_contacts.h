// The on-device contact book: up to 16 {name, wallet, usdc_ata}. Enforces I3 (reverse lookup
// only): a parsed destination resolves to a stored name or to "unknown recipient"; nothing ever
// resolves a name sent by the host.
//
// Lookup is by kind (docs/SOLANA.md): a SOL destination is matched only against wallets, a USDC
// destination only against usdc_ata. usdc_ata is always derived on device (tk_ata_derive).
//
// Names (SERIAL_PROTOCOL.md): 1-12 ASCII characters from letters, digits, space, hyphen and
// apostrophe; no leading, trailing or double space; unique ignoring case. Addresses are unique.

#ifndef TK_CONTACTS_H
#define TK_CONTACTS_H

#include <stddef.h>
#include <stdint.h>

#include "tk_parser.h" // tk_tx_kind_t
#include "tk_proto.h"  // tk_status_t
#include "tk_solana_consts.h"

#define TK_CONTACTS_MAX 16u
#define TK_CONTACT_NAME_MAX 12u

typedef struct {
    uint8_t name_len;
    char name[TK_CONTACT_NAME_MAX + 1]; // NUL-terminated
    uint8_t wallet[TK_PUBKEY_LEN];
    uint8_t usdc_ata[TK_PUBKEY_LEN]; // derived on device, never taken from the host
} tk_contact_t;

typedef struct {
    uint8_t count;
    tk_contact_t items[TK_CONTACTS_MAX]; // items[0..count) in insertion order; the rest zeroed
} tk_contacts_t;

typedef enum {
    TK_CONTACTS_OK = 0,
    TK_CONTACTS_BAD_ARG,
    TK_CONTACTS_NAME_INVALID,   // breaks the name rules; on the wire: ERROR{BAD_PAYLOAD}
    TK_CONTACTS_FULL,           // CONTACTS_FULL
    TK_CONTACTS_NAME_EXISTS,    // CONTACT_EXISTS
    TK_CONTACTS_ADDRESS_EXISTS, // CONTACT_EXISTS
    TK_CONTACTS_NOT_FOUND,      // NOT_FOUND
    TK_CONTACTS_ATA_FAILED,     // no off-curve bump (probability ~2^-256)
    TK_CONTACTS_BAD_BLOB,       // tk_contacts_load: corrupt or invalid saved table
} tk_contacts_result_t;

void tk_contacts_init(tk_contacts_t *c);

// Zero the whole table with memzero (PIN lockout wipes contacts, I7).
void tk_contacts_wipe(tk_contacts_t *c);

tk_contacts_result_t tk_contacts_validate_name(const uint8_t *name, size_t len);

// Every check tk_contacts_add makes, without changing the table. The enrollment flow calls this
// before speaking "Adding <name>", so a request that would fail is refused up front.
tk_contacts_result_t tk_contacts_check_add(const tk_contacts_t *c, const uint8_t *name, size_t len,
                                           const uint8_t wallet[TK_PUBKEY_LEN]);

// Append a contact, deriving its USDC ATA. The table is unchanged on any failure.
tk_contacts_result_t tk_contacts_add(tk_contacts_t *c, const uint8_t *name, size_t len,
                                     const uint8_t wallet[TK_PUBKEY_LEN]);

// Remove items[index]; later entries move down one place (order is kept) and the freed slot is
// zeroed. CONTACT_REMOVE{index} uses this order.
tk_contacts_result_t tk_contacts_remove(tk_contacts_t *c, uint8_t index);

// NULL if index >= count.
const tk_contact_t *tk_contacts_get(const tk_contacts_t *c, uint8_t index);

// The contact index for a parsed destination, or -1 for "unknown recipient".
int tk_contacts_find(const tk_contacts_t *c, tk_tx_kind_t kind, const uint8_t dest[TK_PUBKEY_LEN]);

// Wire status for a result: OK, CONTACTS_FULL, CONTACT_EXISTS or NOT_FOUND. NAME_INVALID is
// answered with ERROR{BAD_PAYLOAD} instead, and the other results never reach the wire; both map
// to PARSE_UNSUPPORTED here only so the function is total.
tk_status_t tk_contacts_status(tk_contacts_result_t r);

// Saved form: "TKC1", count, 16 slots of {name_len, name[12], wallet[32]}, CRC-32 (LE) of all
// preceding bytes. USDC ATAs are not saved; tk_contacts_load derives them again.
#define TK_CONTACTS_SLOT_LEN (1u + TK_CONTACT_NAME_MAX + TK_PUBKEY_LEN)
#define TK_CONTACTS_BLOB_LEN (4u + 1u + TK_CONTACTS_MAX * TK_CONTACTS_SLOT_LEN + 4u)

// Returns TK_CONTACTS_BLOB_LEN, or 0 if cap is too small or an argument is NULL.
size_t tk_contacts_save(const tk_contacts_t *c, uint8_t *out, size_t cap);

// Replace *c with a saved table. Checks length, magic, CRC, count, every name and no duplicates.
// On any failure returns TK_CONTACTS_BAD_BLOB and leaves *c empty (never a partial table).
tk_contacts_result_t tk_contacts_load(tk_contacts_t *c, const uint8_t *blob, size_t len);

#endif
