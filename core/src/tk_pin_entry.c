#include "tk_pin_entry.h"

#include "memzero.h"
#include "tk_clips.h"

// Uniform digit 0-9 from the RNG: bytes 250-255 are drawn again so no digit is favoured.
static bool random_digit(const tk_ui_t *ui, uint8_t *digit) {
    for (int tries = 0; tries < 64; tries++) {
        uint8_t b = 0;
        if (!ui->random_bytes(ui->ctx, &b, 1)) {
            return false;
        }
        if (b < 250) {
            *digit = (uint8_t)(b % 10);
            return true;
        }
    }
    return false; // 64 draws all >= 250: the RNG is broken
}

static void announce_digit(const tk_ui_t *ui, size_t index, uint8_t value) {
    ui->play(ui->ctx, TK_CLIP_DIGIT);
    ui->play(ui->ctx, (uint16_t)(TK_CLIP_ZERO + index + 1)); // "digit three"
    ui->play(ui->ctx, (uint16_t)(TK_CLIP_ZERO + value));
}

static tk_pin_result_t entry(const tk_ui_t *ui, uint8_t pin[TK_PIN_LEN]) {
    size_t i = 0;
    uint8_t value = 0;
    if (!random_digit(ui, &value)) {
        return TK_PIN_RNG_FAILED;
    }
    announce_digit(ui, i, value);
    for (;;) {
        const tk_button_t b = ui->wait(ui->ctx, TK_PIN_IDLE_TIMEOUT_MS);
        switch (b) {
        case TK_BTN_NONE:
            return TK_PIN_TIMEOUT;
        case TK_BTN_REJECT_LONG:
            return TK_PIN_CANCELLED;
        case TK_BTN_REJECT:
            return TK_PIN_REJECTED;
        case TK_BTN_UP:
        case TK_BTN_DOWN:
            ui->haptic(ui->ctx, TK_HAPTIC_TICK);
            value = (uint8_t)(b == TK_BTN_UP ? (value + 1) % 10 : (value + 9) % 10);
            ui->play(ui->ctx, (uint16_t)(TK_CLIP_ZERO + value));
            break;
        case TK_BTN_OK:
            ui->haptic(ui->ctx, TK_HAPTIC_TICK);
            pin[i++] = value;
            if (i == TK_PIN_LEN) {
                return TK_PIN_OK;
            }
            if (!random_digit(ui, &value)) {
                return TK_PIN_RNG_FAILED;
            }
            announce_digit(ui, i, value);
            break;
        case TK_BTN_BACK:
            ui->haptic(ui->ctx, TK_HAPTIC_TICK);
            if (i > 0) {
                i--;
                pin[i] = 0;
                if (!random_digit(ui, &value)) {
                    return TK_PIN_RNG_FAILED;
                }
            }
            announce_digit(ui, i, value);
            break;
        case TK_BTN_OK_LONG: // repeat
            announce_digit(ui, i, value);
            break;
        default: // CONFIRM: not meaningful here
            break;
        }
    }
}

tk_pin_result_t tk_pin_entry(const tk_ui_t *ui, uint8_t pin[TK_PIN_LEN]) {
    memzero(pin, TK_PIN_LEN);
    const tk_pin_result_t r = entry(ui, pin);
    if (r != TK_PIN_OK) {
        memzero(pin, TK_PIN_LEN);
    }
    return r;
}
