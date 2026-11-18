// SETUP: create the wallet entirely on the device (SERIAL_PROTOCOL.md, AUDIO.md "SETUP").
//
//   checks -> new PIN, PIN again (press timing captured) -> generate (hardware RNG + timing, BIP39,
//   SLIP-10) -> the 24 recovery words, spelled into the earpiece -> store (key store create)
//
// Nothing is stored until the user has heard every word and pressed OK, so cancelling at any point
// leaves no wallet. Refused with WALLET_EXISTS while a wallet exists (I10). Recovery letters and PIN
// digit values are secret clips (I2); nothing secret is sent on the link or logged.

#include "tk_setup.h"

#include <string.h>

#include "ed25519.h"
#include "memzero.h"
#include "sha2.h"
#include "tk_clips.h"
#include "tk_device_io.h"
#include "tk_pin_entry.h"
#include "tk_seed.h"
#include "tk_speech.h"
#include "tk_util.h"

// Everything secret the flow holds; wiped on every exit path.
typedef struct {
    uint8_t pin1[TK_PIN_LEN];
    uint8_t pin2[TK_PIN_LEN];
    SHA256_CTX timing;     // press timing during PIN entry (SECURITY_MODEL I11)
    uint8_t timing_digest[32];
    uint8_t hw[TK_SEED_ENTROPY_LEN];
    uint8_t entropy[TK_SEED_ENTROPY_LEN];
    uint16_t idx[TK_SEED_WORDS];
    uint8_t seed[TK_SEED_LEN];
    uint8_t sk[TK_SEED_KEY_LEN];
    uint8_t pubkey[32];
} setup_secrets_t;

// ---- A tk_ui_t that records when each press arrives ----

typedef struct {
    tk_device_t *d;
    SHA256_CTX *h;
    uint32_t last_ms;
} timing_ui_t;

static void t_play(void *ctx, uint16_t clip, bool secret) {
    const timing_ui_t *t = ctx;
    t->d->ui.play(t->d->ui.ctx, clip, secret);
}

static void t_haptic(void *ctx, tk_haptic_t pattern) {
    const timing_ui_t *t = ctx;
    t->d->ui.haptic(t->d->ui.ctx, pattern);
}

static bool t_random(void *ctx, uint8_t *out, size_t len) {
    const timing_ui_t *t = ctx;
    return t->d->ui.random_bytes(t->d->ui.ctx, out, len);
}

static tk_button_t t_wait(void *ctx, uint32_t timeout_ms) {
    timing_ui_t *t = ctx;
    const tk_button_t b = t->d->ui.wait(t->d->ui.ctx, timeout_ms);
    if (b != TK_BTN_NONE) {
        const tk_platform_t *p = t->d->platform;
        const uint32_t now = p->now_ms(p->ctx);
        const uint32_t dt = now - t->last_ms;
        t->last_ms = now;
        const uint8_t rec[5] = {(uint8_t)b, (uint8_t)dt, (uint8_t)(dt >> 8), (uint8_t)(dt >> 16), (uint8_t)(dt >> 24)};
        sha256_Update(t->h, rec, sizeof(rec));
    }
    return b;
}

// ---- Endings ----

// Like the sign flow's: played straight on the platform, so it is heard even after a host CANCEL.
static tk_status_t end(tk_device_t *d, tk_status_t status, tk_haptic_t haptic) {
    d->platform->haptic(d->platform->ctx, haptic);
    d->platform->play_clip(d->platform->ctx, TK_CLIP_CANCELLED, false);
    return status;
}

static tk_status_t end_cancelled(tk_device_t *d) {
    return end(d, TK_STATUS_CANCELLED, TK_HAPTIC_REJECT);
}

// A PIN entry that did not finish: the status to reply with.
static tk_status_t pin_failed(tk_device_t *d, tk_pin_result_t r) {
    if (d->cancel || r == TK_PIN_CANCELLED || r == TK_PIN_TIMEOUT) {
        return end_cancelled(d);
    }
    if (r == TK_PIN_REJECTED) {
        return end(d, TK_STATUS_REJECTED_BY_USER, TK_HAPTIC_REJECT);
    }
    return end(d, TK_STATUS_DEVICE_ERROR, TK_HAPTIC_WARNING); // RNG failed
}

// ---- Steps ----

static tk_status_t choose_pin(tk_device_t *d, setup_secrets_t *s) {
    timing_ui_t t = {d, &s->timing, d->platform->now_ms(d->platform->ctx)};
    const tk_ui_t ui = {&t, t_play, t_haptic, t_wait, t_random};
    tk_dev_send_event(d, TK_EVENT_AWAITING_PIN);
    for (unsigned mismatches = 0;;) {
        tk_dev_say(d, TK_CLIP_CHOOSE_PIN);
        tk_pin_result_t r = tk_pin_entry(&ui, s->pin1);
        if (r != TK_PIN_OK || d->cancel) {
            return pin_failed(d, r);
        }
        tk_dev_say(d, TK_CLIP_ENTER_PIN_AGAIN);
        r = tk_pin_entry(&ui, s->pin2);
        if (r != TK_PIN_OK || d->cancel) {
            return pin_failed(d, r);
        }
        const bool same = tk_ct_equal(s->pin1, s->pin2, TK_PIN_LEN);
        memzero(s->pin2, sizeof(s->pin2));
        if (same) {
            return TK_STATUS_OK;
        }
        memzero(s->pin1, sizeof(s->pin1));
        if (++mismatches >= TK_SETUP_MAX_MISMATCH) {
            return end_cancelled(d);
        }
        d->platform->haptic(d->platform->ctx, TK_HAPTIC_WARNING);
        tk_dev_say(d, TK_CLIP_PINS_DONT_MATCH);
    }
}

static tk_status_t generate(tk_device_t *d, setup_secrets_t *s) {
    tk_dev_say(d, TK_CLIP_PLEASE_WAIT);
    if (!d->ui.random_bytes(d->ui.ctx, s->hw, sizeof(s->hw))) {
        return end(d, TK_STATUS_DEVICE_ERROR, TK_HAPTIC_WARNING);
    }
    sha256_Final(&s->timing, s->timing_digest); // also wipes the context
    tk_seed_mix_entropy(s->hw, s->timing_digest, s->entropy);
    if (!tk_seed_words(s->entropy, s->idx) || !tk_seed_bip39(s->idx, "", s->seed) ||
        !tk_slip10_ed25519(s->seed, sizeof(s->seed), TK_SOLANA_PATH, TK_SOLANA_PATH_LEN, s->sk)) {
        return end(d, TK_STATUS_DEVICE_ERROR, TK_HAPTIC_WARNING);
    }
    ed25519_publickey(s->sk, s->pubkey);
    memzero(s->hw, sizeof(s->hw));
    memzero(s->entropy, sizeof(s->entropy));
    memzero(s->seed, sizeof(s->seed));
    return TK_STATUS_OK;
}

// "recovery word <n>, A, B, A, N, D, O, N": the whole word is spelled, so what the user writes
// down is the real BIP39 word. The position is public, the letters are secret (I2).
static void play_word(tk_device_t *d, const setup_secrets_t *s, size_t i) {
    uint16_t clips[8];
    tk_dev_say(d, TK_CLIP_RECOVERY_WORD);
    size_t n;
    if (i + 1 >= 21) { // 21-24: one clip each, so the number can't run into the letters
        clips[0] = (uint16_t)(TK_CLIP_TWENTY_ONE + (i + 1 - 21));
        n = 1;
    } else {
        n = tk_speech_number(i + 1, clips, sizeof(clips) / sizeof(clips[0]));
    }
    for (size_t k = 0; k < n; k++) {
        tk_dev_say(d, clips[k]);
    }
    const char *word = tk_seed_word(s->idx[i]);
    for (size_t k = 0; word != NULL && word[k] != '\0'; k++) { // 3..8 letters
        tk_dev_play(d, (uint16_t)(TK_CLIP_LETTER_A + (word[k] - 'a')), true);
    }
}

static tk_status_t recovery_words(tk_device_t *d, const setup_secrets_t *s) {
    tk_dev_say(d, TK_CLIP_WRITE_DOWN);
    size_t i = 0; // TK_SEED_WORDS = the final prompt
    bool helped = false;
    for (;;) {
        if (i < TK_SEED_WORDS) {
            play_word(d, s, i);
            if (!helped) {
                tk_dev_say(d, TK_CLIP_NEXT_WORD_HELP);
                helped = true;
            }
        } else {
            tk_dev_say(d, TK_CLIP_REPLAY_ALL);
        }
        for (bool replay = false; !replay;) {
            if (d->cancel) {
                return end_cancelled(d);
            }
            const tk_button_t b = d->ui.wait(d->ui.ctx, TK_SETUP_WORD_TIMEOUT_MS);
            switch (b) {
            case TK_BTN_NONE: // timed out
            case TK_BTN_REJECT_LONG: // or host CANCEL
                return end_cancelled(d);
            case TK_BTN_REJECT:
                return end(d, TK_STATUS_REJECTED_BY_USER, TK_HAPTIC_REJECT);
            case TK_BTN_OK:
                d->ui.haptic(d->ui.ctx, TK_HAPTIC_TICK);
                if (i == TK_SEED_WORDS) {
                    return TK_STATUS_OK;
                }
                i++;
                replay = true;
                break;
            case TK_BTN_OK_LONG:
                if (i == TK_SEED_WORDS) {
                    i = 0; // hear them all again
                }
                replay = true;
                break;
            case TK_BTN_BACK:
                d->ui.haptic(d->ui.ctx, TK_HAPTIC_TICK);
                if (i > 0) {
                    i--;
                }
                replay = true;
                break;
            default: // UP, DOWN, CONFIRM: nothing to do here
                break;
            }
        }
    }
}

static tk_status_t setup(tk_device_t *d, setup_secrets_t *s) {
    const tk_platform_t *p = d->platform;
    const tk_wallet_ops_t *w = d->wallet;

    // A new wallet starts with an empty contact book (only non-empty after an interrupted wipe).
    if (d->contacts->count > 0) {
        uint8_t blob[TK_CONTACTS_BLOB_LEN];
        tk_contacts_wipe(d->contacts);
        if (tk_contacts_save(d->contacts, blob, sizeof(blob)) != sizeof(blob) ||
            !p->storage_set(p->ctx, TK_STORAGE_CONTACTS, blob, sizeof(blob))) {
            p->haptic(p->ctx, TK_HAPTIC_WARNING);
            return TK_STATUS_DEVICE_ERROR;
        }
    }

    sha256_Init(&s->timing);
    tk_status_t st = choose_pin(d, s);
    if (st == TK_STATUS_OK) {
        st = generate(d, s);
    }
    if (st == TK_STATUS_OK) {
        st = recovery_words(d, s);
    }
    if (st != TK_STATUS_OK) {
        return st;
    }

    p->haptic(p->ctx, TK_HAPTIC_TICK);
    tk_dev_say(d, TK_CLIP_PLEASE_WAIT);
    if (!w->create(w->ctx, s->pin1, s->sk, s->pubkey)) { // the key store stores it (I7)
        return end(d, TK_STATUS_DEVICE_ERROR, TK_HAPTIC_WARNING);
    }
    (void)tk_dev_ensure_keys(d);
    p->haptic(p->ctx, TK_HAPTIC_SUCCESS);
    tk_dev_say(d, TK_CLIP_WALLET_CREATED);
    return TK_STATUS_OK;
}

tk_status_t tk_setup_run(tk_device_t *d) {
    const tk_platform_t *p = d->platform;
    const tk_wallet_ops_t *w = d->wallet;
    if (w->has_wallet(w->ctx)) {
        return TK_STATUS_WALLET_EXISTS; // I10; silent
    }
    if (p->audio_ok == NULL || !p->audio_ok(p->ctx)) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING); // can't speak the words: refuse (Q7)
        return TK_STATUS_DEVICE_ERROR;
    }
    if (p->private_audio_only == NULL || !p->private_audio_only(p->ctx)) {
        p->haptic(p->ctx, TK_HAPTIC_WARNING); // speaker mode: recovery playback is refused (AUDIO.md)
        p->play_clip(p->ctx, TK_CLIP_CANCELLED, false);
        return TK_STATUS_DEVICE_ERROR;
    }
    setup_secrets_t s;
    memset(&s, 0, sizeof(s));
    const tk_status_t st = setup(d, &s);
    memzero(&s, sizeof(s));
    return st;
}
