// CONTACT_ADD: enroll a contact on the device (ARCHITECTURE.md "Contact enrollment flow").
//
//   refusals (no wallet, no audio, book full, duplicate) -> "adding contact <spelled name>, address
//   phrase <8 words>" -> PIN if locked -> confirm window (hold OK repeats) -> store
//
// The 8-word address phrase (tk_checksum_addr, 64 bits) is what the user compares with the
// contact over the phone; it is derived from a public address, so its clips are public (AUDIO.md).
// Nothing is stored unless the reply is OK, and the book in RAM always matches what is saved.
// Adding a contact is not a signature: an unlocked session stays unlocked.

#include "tk_enroll.h"

#include <string.h>

#include "memzero.h"
#include "tk_checksum.h"
#include "tk_clips.h"
#include "tk_device_io.h"
#include "tk_speech.h"

typedef struct {
    const uint8_t *name;
    uint8_t name_len;
    uint8_t words[TK_ADDR_PHRASE_WORDS];
} enroll_t;

// "adding contact <spelled name>, address phrase <w1 ... w8>"
static void announce(tk_device_t *d, void *ctx) {
    const enroll_t *e = ctx;
    uint16_t clips[TK_SPEECH_AMOUNT_MAX];
    tk_dev_say(d, TK_CLIP_ADDING_CONTACT);
    const size_t n = tk_speech_spell((const char *)e->name, e->name_len, clips, TK_SPEECH_AMOUNT_MAX);
    for (size_t i = 0; i < n && !d->cancel; i++) {
        tk_dev_say(d, clips[i]);
    }
    tk_dev_say(d, TK_CLIP_ADDRESS_PHRASE);
    for (size_t i = 0; i < TK_ADDR_PHRASE_WORDS && !d->cancel; i++) {
        tk_dev_say(d, (uint16_t)(TK_CLIP_WORD_0 + e->words[i])); // public: from a public address
    }
}

static tk_status_t refuse(tk_device_t *d, tk_status_t status, uint16_t clip) {
    const tk_platform_t *p = d->platform;
    p->haptic(p->ctx, TK_HAPTIC_WARNING);
    tk_dev_say(d, clip);
    return status;
}

// Add and save; on a failed save the contact is taken out of RAM again.
static tk_status_t store(tk_device_t *d, const enroll_t *e, const uint8_t wallet[TK_PUBKEY_LEN]) {
    const tk_platform_t *p = d->platform;
    uint8_t blob[TK_CONTACTS_BLOB_LEN];
    if (tk_contacts_add(d->contacts, e->name, e->name_len, wallet) != TK_CONTACTS_OK) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING);
        return TK_STATUS_DEVICE_ERROR; // only ATA_FAILED is possible here (checked up front)
    }
    if (tk_contacts_save(d->contacts, blob, sizeof(blob)) != sizeof(blob) ||
        !p->storage_set(p->ctx, TK_STORAGE_CONTACTS, blob, sizeof(blob))) {
        (void)tk_contacts_remove(d->contacts, (uint8_t)(d->contacts->count - 1u));
        p->haptic(p->ctx, TK_HAPTIC_WARNING);
        return TK_STATUS_DEVICE_ERROR;
    }
    p->haptic(p->ctx, TK_HAPTIC_SUCCESS);
    tk_dev_say(d, TK_CLIP_CONTACT_ADDED);
    return TK_STATUS_OK;
}

tk_status_t tk_enroll_run(tk_device_t *d, uint8_t name_len, const uint8_t *name, const uint8_t wallet[TK_PUBKEY_LEN]) {
    const tk_platform_t *p = d->platform;
    const tk_wallet_ops_t *w = d->wallet;
    if (!w->has_wallet(w->ctx)) {
        return TK_STATUS_NO_WALLET; // silent
    }
    if (!tk_dev_audio_ok(d)) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING); // the user can't hear the name or phrase: refuse (Q7)
        return TK_STATUS_DEVICE_ERROR;
    }
    switch (tk_contacts_check_add(d->contacts, name, name_len, wallet)) {
    case TK_CONTACTS_OK:
        break;
    case TK_CONTACTS_FULL:
        return refuse(d, TK_STATUS_CONTACTS_FULL, TK_CLIP_CONTACT_BOOK_FULL);
    case TK_CONTACTS_NAME_EXISTS:
    case TK_CONTACTS_ADDRESS_EXISTS:
        return refuse(d, TK_STATUS_CONTACT_EXISTS, TK_CLIP_ALREADY_A_CONTACT);
    default: // the name was validated by the caller; ATA_FAILED (~2^-256) or a bug
        p->haptic(p->ctx, TK_HAPTIC_WARNING);
        return TK_STATUS_DEVICE_ERROR;
    }

    enroll_t e;
    memset(&e, 0, sizeof(e));
    e.name = name;
    e.name_len = name_len;
    tk_checksum_addr(wallet, e.words);

    tk_dev_send_event(d, TK_EVENT_ANNOUNCING);
    announce(d, &e);
    tk_status_t st = TK_STATUS_OK;
    if (d->cancel) {
        st = tk_dev_finish_cancelled(d);
    }
    uint8_t pin[TK_PIN_LEN];
    if (st == TK_STATUS_OK) {
        st = tk_dev_unlock(d, pin, false); // wipes pin
    }
    if (st == TK_STATUS_OK) {
        st = tk_dev_confirm_window(d, TK_CLIP_PRESS_CONFIRM_ADD, announce, &e);
    }
    if (st == TK_STATUS_OK) {
        st = store(d, &e, wallet);
    }
    memzero(pin, sizeof(pin));
    memzero(&e, sizeof(e));
    return st;
}
