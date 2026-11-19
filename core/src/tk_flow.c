// Request dispatch, the SIGN_REQUEST and UNLOCK flows (SETUP is in tk_setup.c, CONTACT_ADD in tk_enroll.c).
// See tk_device.h.

#include <string.h>

#include "memzero.h"
#include "tk_ata.h"
#include "tk_checksum.h"
#include "tk_clips.h"
#include "tk_device.h"
#include "tk_device_io.h"
#include "tk_enroll.h"
#include "tk_setup.h"
#include "tk_speech.h"

// ---- Serial output ----

static void send(tk_device_t *d, uint8_t type, uint8_t seq, const uint8_t *payload, size_t len) {
    size_t n = 0;
    if (tk_frame_encode(type, seq, payload, len, d->tx, sizeof(d->tx), &n) == TK_FRAME_ENC_OK) {
        d->platform->serial_write(d->platform->ctx, d->tx, n);
    }
}

static void send_status(tk_device_t *d, uint8_t req_type, uint8_t seq, tk_status_t status) {
    const uint8_t s = (uint8_t)status;
    send(d, (uint8_t)(req_type | TK_MSG_RESPONSE_BIT), seq, &s, 1);
}

static void send_error(tk_device_t *d, uint8_t seq, tk_proto_err_code_t code) {
    const uint8_t c = (uint8_t)code;
    send(d, TK_MSG_ERROR, seq, &c, 1);
}

static void send_event(tk_device_t *d, tk_event_t event) {
    const uint8_t e = (uint8_t)event;
    send(d, TK_MSG_EVENT, d->flow_seq, &e, 1);
}

// ---- Serial input ----

// Next decoder event from buffered or newly read bytes; TK_FRAME_NEED_MORE when the link is idle.
static tk_frame_result_t next_frame(tk_device_t *d, tk_frame_t *f) {
    for (;;) {
        size_t used = 0;
        const tk_frame_result_t r =
            tk_frame_decoder_feed(&d->decoder, d->rx + d->rx_pos, d->rx_len - d->rx_pos, &used, f);
        d->rx_pos += used;
        if (r != TK_FRAME_NEED_MORE) {
            return r;
        }
        d->rx_pos = 0;
        d->rx_len = d->platform->serial_read(d->platform->ctx, d->rx, sizeof(d->rx));
        if (d->rx_len > sizeof(d->rx)) { // defensive: a platform bug must not cause an over-read
            d->rx_len = 0;
        }
        if (d->rx_len == 0) {
            return TK_FRAME_NEED_MORE;
        }
    }
}

static uint8_t hello_state(const tk_device_t *d) {
    const tk_wallet_ops_t *w = d->wallet;
    if (!w->has_wallet(w->ctx)) {
        return TK_STATE_NO_WALLET;
    }
    return w->is_unlocked(w->ctx) ? TK_STATE_UNLOCKED : TK_STATE_LOCKED;
}

static void reply_hello(tk_device_t *d, uint8_t seq) {
    const uint8_t p[4] = {(uint8_t)(TK_FW_VERSION & 0xFF), (uint8_t)(TK_FW_VERSION >> 8), TK_PROTO_VERSION,
                          hello_state(d)};
    send(d, TK_MSG_HELLO | TK_MSG_RESPONSE_BIT, seq, p, sizeof(p));
}

// A request that arrives while a flow runs (decision 8).
static void handle_in_flow(tk_device_t *d, const tk_frame_t *f) {
    if (f->type == TK_MSG_HELLO || f->type == TK_MSG_CANCEL) {
        if (f->len != 0) {
            send_error(d, f->seq, TK_PROTO_ERR_BAD_PAYLOAD);
        } else if (f->type == TK_MSG_HELLO) {
            reply_hello(d, f->seq);
        } else {
            send_status(d, TK_MSG_CANCEL, f->seq, TK_STATUS_OK);
            d->cancel = true;
        }
        return;
    }
    send_status(d, f->type, f->seq, TK_STATUS_BUSY);
}

static void handle_decoder_error(tk_device_t *d, tk_frame_result_t r, const tk_frame_t *f) {
    send_error(d, f->seq, r == TK_FRAME_TOO_LARGE ? TK_PROTO_ERR_TOO_LARGE : TK_PROTO_ERR_BAD_FRAME);
}

// Service the serial link during a flow.
static void pump(tk_device_t *d) {
    tk_frame_t f;
    tk_frame_result_t r;
    while ((r = next_frame(d, &f)) != TK_FRAME_NEED_MORE) {
        if (r == TK_FRAME_OK) {
            handle_in_flow(d, &f);
        } else {
            handle_decoder_error(d, r, &f);
        }
    }
}

// ---- Flow I/O (tk_ui_t over the platform, with serial servicing) ----

static void ui_play(void *ctx, uint16_t clip, bool secret) {
    tk_device_t *d = ctx;
    pump(d);
    if (d->cancel) {
        return; // stop talking once the host has cancelled
    }
    d->platform->play_clip(d->platform->ctx, clip, secret);
    pump(d);
}

static void say(tk_device_t *d, uint16_t clip) {
    ui_play(d, clip, false);
}

static void ui_haptic(void *ctx, tk_haptic_t pattern) {
    tk_device_t *d = ctx;
    d->platform->haptic(d->platform->ctx, pattern);
}

static tk_button_t ui_wait(void *ctx, uint32_t timeout_ms) {
    tk_device_t *d = ctx;
    const tk_platform_t *p = d->platform;
    const uint32_t start = p->now_ms(p->ctx);
    for (;;) {
        pump(d);
        if (d->cancel) {
            return TK_BTN_REJECT_LONG;
        }
        const uint32_t elapsed = p->now_ms(p->ctx) - start;
        if (elapsed >= timeout_ms) {
            return TK_BTN_NONE;
        }
        const uint32_t left = timeout_ms - elapsed;
        const tk_button_t b = p->wait_button(p->ctx, left < TK_WAIT_SLICE_MS ? left : TK_WAIT_SLICE_MS);
        if (b != TK_BTN_NONE) {
            return b;
        }
    }
}

static bool ui_random(void *ctx, uint8_t *out, size_t len) {
    tk_device_t *d = ctx;
    return d->platform->random_bytes(d->platform->ctx, out, len);
}

// ---- Shared with other flows (tk_device_io.h) ----

void tk_dev_play(tk_device_t *d, uint16_t clip, bool secret) {
    ui_play(d, clip, secret);
}

void tk_dev_say(tk_device_t *d, uint16_t clip) {
    say(d, clip);
}

void tk_dev_send_event(tk_device_t *d, tk_event_t event) {
    send_event(d, event);
}

static bool ensure_keys(tk_device_t *d);

bool tk_dev_ensure_keys(tk_device_t *d) {
    return ensure_keys(d);
}

// ---- SIGN_REQUEST flow ----

static bool audio_ok(const tk_device_t *d) {
    const tk_platform_t *p = d->platform;
    return p->audio_ok != NULL && p->audio_ok(p->ctx); // missing hook: assume no audio
}

static bool ensure_keys(tk_device_t *d) {
    if (d->keys_ready) {
        return true;
    }
    uint8_t bump = 0;
    if (!d->wallet->get_pubkey(d->wallet->ctx, d->pubkey) ||
        !tk_ata_derive(d->pubkey, TK_DEVNET_USDC_MINT, d->usdc_ata, &bump)) {
        return false;
    }
    d->keys_ready = true;
    return true;
}

static void play_all(tk_device_t *d, const uint16_t *clips, size_t n) {
    for (size_t i = 0; i < n && !d->cancel; i++) {
        say(d, clips[i]);
    }
}

bool tk_dev_audio_ok(const tk_device_t *d) {
    return audio_ok(d);
}

// "send <amount> <token> to <name> checksum <w1 w2 w3>"
static void announce(tk_device_t *d, const tk_tx_t *tx, const tk_contact_t *c, const uint8_t ck[TK_TX_PHRASE_WORDS]) {
    uint16_t clips[TK_SPEECH_AMOUNT_MAX];
    say(d, TK_CLIP_SEND);
    play_all(d, clips, tk_speech_amount(tx->kind, tx->amount, clips, TK_SPEECH_AMOUNT_MAX));
    say(d, tx->kind == TK_TX_SOL ? TK_CLIP_SOL : TK_CLIP_USDC);
    say(d, TK_CLIP_TO);
    play_all(d, clips, tk_speech_spell(c->name, c->name_len, clips, TK_SPEECH_AMOUNT_MAX));
    say(d, TK_CLIP_CHECKSUM);
    for (size_t i = 0; i < TK_TX_PHRASE_WORDS; i++) {
        ui_play(d, (uint16_t)(TK_CLIP_WORD_0 + ck[i]), true); // secret (I2)
    }
    memzero(clips, sizeof(clips));
}

static tk_status_t finish_cancelled(tk_device_t *d) {
    d->platform->haptic(d->platform->ctx, TK_HAPTIC_REJECT);
    d->platform->play_clip(d->platform->ctx, TK_CLIP_CANCELLED, false);
    return TK_STATUS_CANCELLED;
}

static tk_status_t finish_rejected(tk_device_t *d) {
    d->platform->haptic(d->platform->ctx, TK_HAPTIC_REJECT);
    say(d, TK_CLIP_CANCELLED);
    return TK_STATUS_REJECTED_BY_USER;
}

tk_status_t tk_dev_finish_cancelled(tk_device_t *d) {
    return finish_cancelled(d);
}

static void lockout_wipe(tk_device_t *d) {
    uint8_t blob[TK_CONTACTS_BLOB_LEN];
    tk_contacts_wipe(d->contacts);
    if (tk_contacts_save(d->contacts, blob, sizeof(blob)) == sizeof(blob)) {
        d->platform->storage_set(d->platform->ctx, TK_STORAGE_CONTACTS, blob, sizeof(blob));
    }
    d->keys_ready = false;
    memzero(d->pubkey, sizeof(d->pubkey));
    memzero(d->usdc_ata, sizeof(d->usdc_ata));
}

// Secrets the flow holds; wiped by the caller on every exit path.
typedef struct {
    uint8_t pin[TK_PIN_LEN];
    uint8_t ck[TK_TX_PHRASE_WORDS];
    uint8_t sig[TK_SIGNATURE_LEN];
} flow_secrets_t;

tk_status_t tk_dev_unlock(tk_device_t *d, uint8_t pin[TK_PIN_LEN], bool signing) {
    const tk_wallet_ops_t *w = d->wallet;
    while (!w->is_unlocked(w->ctx)) {
        send_event(d, TK_EVENT_AWAITING_PIN);
        say(d, TK_CLIP_ENTER_PIN);
        const tk_pin_result_t pr = tk_pin_entry(&d->ui, pin);
        if (pr == TK_PIN_CANCELLED || d->cancel) {
            memzero(pin, TK_PIN_LEN);
            return finish_cancelled(d);
        }
        if (pr != TK_PIN_OK) {
            memzero(pin, TK_PIN_LEN);
            return finish_rejected(d);
        }
        uint8_t left = 0;
        say(d, TK_CLIP_PLEASE_WAIT); // the PIN key derivation takes ~2.6 s (I7)
        const tk_unlock_result_t ur = w->unlock(w->ctx, pin, &left);
        memzero(pin, TK_PIN_LEN);
        if (ur == TK_UNLOCK_OK) {
            break;
        }
        if (ur == TK_UNLOCK_ERROR) { // the key store can't check a PIN: fail closed
            d->platform->haptic(d->platform->ctx, TK_HAPTIC_WARNING);
            say(d, signing ? TK_CLIP_CANNOT_SIGN : TK_CLIP_CANCELLED); // UNLOCK, CONTACT_ADD sign nothing
            return TK_STATUS_DEVICE_ERROR;
        }
        if (ur == TK_UNLOCK_LOCKED_OUT) {
            lockout_wipe(d);
            d->platform->haptic(d->platform->ctx, TK_HAPTIC_WARNING);
            d->platform->play_clip(d->platform->ctx, TK_CLIP_WALLET_WIPED, false);
            return TK_STATUS_LOCKED_OUT;
        }
        d->platform->haptic(d->platform->ctx, TK_HAPTIC_WARNING);
        say(d, TK_CLIP_WRONG_PIN);
        say(d, (uint16_t)(TK_CLIP_ZERO + (left < 20 ? left : 19)));
        say(d, TK_CLIP_ATTEMPTS_REMAINING);
    }
    return TK_STATUS_OK;
}

// Confirm window (I6): presses during the announcement were discarded by the platform.
tk_status_t tk_dev_confirm_window(tk_device_t *d, uint16_t prompt, tk_dev_announce_fn repeat, void *ctx) {
    const tk_platform_t *p = d->platform;
    send_event(d, TK_EVENT_AWAITING_CONFIRM);
    say(d, prompt);
    uint32_t start = p->now_ms(p->ctx);
    for (;;) {
        if (d->cancel) {
            return finish_cancelled(d);
        }
        const uint32_t elapsed = p->now_ms(p->ctx) - start;
        if (elapsed >= TK_CONFIRM_TIMEOUT_MS) {
            return finish_rejected(d);
        }
        const tk_button_t b = ui_wait(d, TK_CONFIRM_TIMEOUT_MS - elapsed);
        if (b == TK_BTN_CONFIRM) {
            return TK_STATUS_OK;
        }
        if (b == TK_BTN_REJECT || b == TK_BTN_NONE) {
            return finish_rejected(d);
        }
        if (b == TK_BTN_REJECT_LONG) {
            return finish_cancelled(d);
        }
        if (b == TK_BTN_OK_LONG) { // repeat, then a fresh confirm window
            repeat(d, ctx);
            say(d, prompt);
            start = p->now_ms(p->ctx);
        }
    }
}

typedef struct {
    const tk_tx_t *tx;
    const tk_contact_t *contact;
    const uint8_t *ck;
} sign_announce_t;

static void sign_repeat(tk_device_t *d, void *ctx) {
    const sign_announce_t *a = ctx;
    announce(d, a->tx, a->contact, a->ck);
}

static tk_status_t run_sign(tk_device_t *d, const uint8_t *msg, size_t len, flow_secrets_t *s) {
    const tk_wallet_ops_t *w = d->wallet;
    const tk_platform_t *p = d->platform;
    if (!w->has_wallet(w->ctx) || !ensure_keys(d)) {
        return TK_STATUS_NO_WALLET;
    }
    if (!audio_ok(d)) {
        // Without audio the user can't hear the amount, recipient or PIN digits: refuse (Q7).
        p->haptic(p->ctx, TK_HAPTIC_WARNING);
        return TK_STATUS_DEVICE_ERROR;
    }

    tk_tx_t tx;
    if (tk_parse_message(msg, len, d->pubkey, d->usdc_ata, &tx) != TK_PARSE_OK) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING);
        say(d, TK_CLIP_CANNOT_SIGN);
        return TK_STATUS_PARSE_UNSUPPORTED;
    }
    const int idx = tk_contacts_find(d->contacts, tx.kind, tx.destination);
    const tk_contact_t *contact = idx >= 0 ? tk_contacts_get(d->contacts, (uint8_t)idx) : NULL;
    if (contact == NULL) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING);
        say(d, TK_CLIP_UNKNOWN_RECIPIENT);
        return TK_STATUS_UNKNOWN_RECIPIENT;
    }

    tk_checksum_tx(msg, len, s->ck);
    send_event(d, TK_EVENT_ANNOUNCING);
    announce(d, &tx, contact, s->ck);
    if (d->cancel) {
        return finish_cancelled(d);
    }

    const tk_status_t us = tk_dev_unlock(d, s->pin, true);
    if (us != TK_STATUS_OK) {
        return us;
    }

    sign_announce_t a = {&tx, contact, s->ck};
    const tk_status_t cs = tk_dev_confirm_window(d, TK_CLIP_PRESS_CONFIRM, sign_repeat, &a);
    if (cs != TK_STATUS_OK) {
        return cs;
    }

    send_event(d, TK_EVENT_SIGNING);
    if (!w->sign(w->ctx, msg, len, s->sig)) {
        // The key store refused (e.g. its session ended). Nothing was signed.
        return finish_cancelled(d);
    }
    p->haptic(p->ctx, TK_HAPTIC_SUCCESS);
    say(d, TK_CLIP_SIGNED);
    return TK_STATUS_OK;
}

static void handle_sign_request(tk_device_t *d, const tk_frame_t *f) {
    if (f->len > sizeof(d->msg)) { // the parser would reject it as TOO_LARGE anyway
        send_status(d, TK_MSG_SIGN_REQUEST, f->seq, TK_STATUS_PARSE_UNSUPPORTED);
        return;
    }
    // Copy out: f->payload points into the decoder, which the flow keeps feeding.
    const size_t len = f->len;
    if (len > 0) {
        memcpy(d->msg, f->payload, len);
    }
    d->in_flow = true;
    d->flow_seq = f->seq;
    d->cancel = false;

    flow_secrets_t s;
    memset(&s, 0, sizeof(s));
    const tk_status_t st = run_sign(d, d->msg, len, &s);
    if (st == TK_STATUS_OK) {
        uint8_t out[1 + TK_SIGNATURE_LEN];
        out[0] = TK_STATUS_OK;
        memcpy(out + 1, s.sig, TK_SIGNATURE_LEN);
        send(d, TK_MSG_SIGN_REQUEST | TK_MSG_RESPONSE_BIT, d->flow_seq, out, sizeof(out));
    } else {
        send_status(d, TK_MSG_SIGN_REQUEST, d->flow_seq, st);
    }
    memzero(&s, sizeof(s));
    memzero(d->msg, len);
    d->in_flow = false;
    d->cancel = false;
}

// ---- UNLOCK: PIN entry ahead of a SIGN_REQUEST ----
//
// The host unlocks first, then fetches a fresh blockhash and sends SIGN_REQUEST, so the signed bytes
// are built after the PIN (a blockhash lasts ~60 s). It only opens the session the key store already
// has (I7: locks after one signature, 5 minutes, USB gone, reboot); every signature still needs the
// announcement and CONFIRM (I5).

static tk_status_t run_unlock(tk_device_t *d) {
    const tk_wallet_ops_t *w = d->wallet;
    const tk_platform_t *p = d->platform;
    if (!w->has_wallet(w->ctx)) {
        return TK_STATUS_NO_WALLET; // silent
    }
    if (w->is_unlocked(w->ctx)) {
        return TK_STATUS_OK; // silent
    }
    if (!audio_ok(d)) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING); // the user can't hear the PIN digits: refuse (Q7)
        return TK_STATUS_DEVICE_ERROR;
    }
    uint8_t pin[TK_PIN_LEN];
    const tk_status_t st = tk_dev_unlock(d, pin, false); // wipes pin
    memzero(pin, sizeof(pin));
    if (st != TK_STATUS_OK) {
        return st;
    }
    p->haptic(p->ctx, TK_HAPTIC_SUCCESS);
    say(d, TK_CLIP_UNLOCKED);
    return TK_STATUS_OK;
}

static void handle_unlock(tk_device_t *d, const tk_frame_t *f) {
    if (f->len != 0) {
        send_error(d, f->seq, TK_PROTO_ERR_BAD_PAYLOAD);
        return;
    }
    d->in_flow = true;
    d->flow_seq = f->seq;
    d->cancel = false;
    const tk_status_t st = run_unlock(d);
    send_status(d, TK_MSG_UNLOCK, d->flow_seq, st);
    d->in_flow = false;
    d->cancel = false;
}

// ---- SETUP (the flow itself is tk_setup_run, tk_setup.c) ----

static void handle_setup(tk_device_t *d, const tk_frame_t *f) {
    if (f->len != 0) {
        send_error(d, f->seq, TK_PROTO_ERR_BAD_PAYLOAD);
        return;
    }
    d->in_flow = true;
    d->flow_seq = f->seq;
    d->cancel = false;
    const tk_status_t st = tk_setup_run(d);
    send_status(d, TK_MSG_SETUP, d->flow_seq, st);
    d->in_flow = false;
    d->cancel = false;
}

// ---- CONTACT_ADD (the flow itself is tk_enroll_run, tk_enroll.c) ----

static void handle_contact_add(tk_device_t *d, const tk_frame_t *f) {
    // Payload: name_len u8 (1-12), name, wallet[32]; a bad payload gets ERROR, nothing played.
    if (f->len < 1 || f->len != 1u + (size_t)f->payload[0] + TK_PUBKEY_LEN ||
        tk_contacts_validate_name(f->payload + 1, f->payload[0]) != TK_CONTACTS_OK) {
        send_error(d, f->seq, TK_PROTO_ERR_BAD_PAYLOAD);
        return;
    }
    // Copy out: f->payload points into the decoder, which the flow keeps feeding.
    const size_t len = f->len;
    memcpy(d->msg, f->payload, len);
    d->in_flow = true;
    d->flow_seq = f->seq;
    d->cancel = false;
    const tk_status_t st = tk_enroll_run(d, d->msg[0], d->msg + 1, d->msg + 1 + d->msg[0]);
    send_status(d, TK_MSG_CONTACT_ADD, d->flow_seq, st);
    memzero(d->msg, len);
    d->in_flow = false;
    d->cancel = false;
}

// ---- Idle dispatch ----

static void handle_idle(tk_device_t *d, const tk_frame_t *f) {
    const tk_wallet_ops_t *w = d->wallet;
    switch (f->type) {
    case TK_MSG_SIGN_REQUEST:
        handle_sign_request(d, f);
        return;
    case TK_MSG_SETUP:
        handle_setup(d, f);
        return;
    case TK_MSG_UNLOCK:
        handle_unlock(d, f);
        return;
    case TK_MSG_CONTACT_ADD:
        handle_contact_add(d, f);
        return;
    case TK_MSG_HELLO:
    case TK_MSG_GET_PUBKEY:
    case TK_MSG_CONTACT_LIST_COUNT:
    case TK_MSG_CANCEL:
        break;
    default:
        // CONTACT_REMOVE is not implemented yet (SERIAL_PROTOCOL.md).
        send_error(d, f->seq, TK_PROTO_ERR_UNKNOWN_TYPE);
        return;
    }
    if (f->len != 0) {
        send_error(d, f->seq, TK_PROTO_ERR_BAD_PAYLOAD);
        return;
    }
    if (f->type == TK_MSG_HELLO) {
        reply_hello(d, f->seq);
    } else if (f->type == TK_MSG_CANCEL) {
        send_status(d, TK_MSG_CANCEL, f->seq, TK_STATUS_OK);
    } else if (f->type == TK_MSG_CONTACT_LIST_COUNT) {
        const uint8_t count = d->contacts->count;
        send(d, TK_MSG_CONTACT_LIST_COUNT | TK_MSG_RESPONSE_BIT, f->seq, &count, 1);
    } else { // GET_PUBKEY
        uint8_t out[1 + TK_PUBKEY_LEN];
        if (w->has_wallet(w->ctx) && ensure_keys(d)) {
            out[0] = TK_STATUS_OK;
            memcpy(out + 1, d->pubkey, TK_PUBKEY_LEN);
            send(d, TK_MSG_GET_PUBKEY | TK_MSG_RESPONSE_BIT, f->seq, out, sizeof(out));
        } else {
            send_status(d, TK_MSG_GET_PUBKEY, f->seq, TK_STATUS_NO_WALLET);
        }
    }
}

void tk_device_init(tk_device_t *d, const tk_platform_t *platform, const tk_wallet_ops_t *wallet,
                    tk_contacts_t *contacts) {
    memset(d, 0, sizeof(*d));
    d->platform = platform;
    d->wallet = wallet;
    d->contacts = contacts;
    tk_frame_decoder_init(&d->decoder);
    d->ui.ctx = d;
    d->ui.play = ui_play;
    d->ui.haptic = ui_haptic;
    d->ui.wait = ui_wait;
    d->ui.random_bytes = ui_random;
    // Contacts without a wallet are left over from a lockout wipe that a power cut interrupted (the
    // key store finished the wallet part at boot): wipe them too, so CONTACT_LIST_COUNT is right.
    if (!wallet->has_wallet(wallet->ctx) && contacts->count > 0) {
        lockout_wipe(d);
    }
}

void tk_device_lock(tk_device_t *d) {
    if (d->wallet->lock != NULL) {
        d->wallet->lock(d->wallet->ctx);
    }
}

void tk_device_link_reset(tk_device_t *d) {
    tk_frame_decoder_reset(&d->decoder);
    d->rx_len = 0;
    d->rx_pos = 0;
}

void tk_device_poll(tk_device_t *d) {
    tk_frame_t f;
    tk_frame_result_t r;
    while ((r = next_frame(d, &f)) != TK_FRAME_NEED_MORE) {
        if (r == TK_FRAME_OK) {
            handle_idle(d, &f);
        } else {
            handle_decoder_error(d, r, &f);
        }
    }
}
