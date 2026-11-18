// Buttons. A periodic esp_timer scans all six pins every 5 ms (no GPIO interrupts: contact bounce
// would fire them many times). A level counts once it has differed from the debounced state for
// 30 ms straight.
//
// UP, DOWN, BACK and CONFIRM report on press. OK and REJECT report on release if held < 2 s, or
// as OK_LONG / REJECT_LONG the moment the hold reaches 2 s (the release then reports nothing).
//
// I6: a clip bumps the epoch at its start and at its end, and wait_button drops every event from an
// older epoch, so nothing queued before or during a clip is ever returned. A button that is down
// when the clip starts or ends is ignored until it is released, so a press that began during the
// clip can't count when it is let go, or as a long press, afterwards.
//
// The speaker-mode chord (OK + BACK held 3 s, core/include/tk_chord.h) is counted only while no clip
// plays and neither button is ignored, and every clip edge restarts it. In a flow, holding OK fires
// OK_LONG (repeat) at 2 s and BACK makes PIN entry speak, so the chord can't complete there; main.c
// only takes it between requests (idle only, docs/AUDIO.md).

#include "buttons.h"

#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "tk_chord.h"
#include "tk_pins.h"

#define N_BTN 6
#define DEBOUNCE_TICKS (TK_BTN_DEBOUNCE_MS / TK_BTN_SCAN_MS)
#define QUEUE_LEN 8
#define BTN_OK 2   // index in DEFS
#define BTN_BACK 3

typedef struct {
    uint8_t pin;
    tk_button_t press;      // reported on press, or on a short release for OK / REJECT
    tk_button_t long_press; // TK_BTN_NONE if the button has no long press
} btn_def_t;

static const btn_def_t DEFS[N_BTN] = {
    {TK_PIN_BTN_UP, TK_BTN_UP, TK_BTN_NONE},
    {TK_PIN_BTN_DOWN, TK_BTN_DOWN, TK_BTN_NONE},
    {TK_PIN_BTN_OK, TK_BTN_OK, TK_BTN_OK_LONG},
    {TK_PIN_BTN_BACK, TK_BTN_BACK, TK_BTN_NONE},
    {TK_PIN_BTN_CONFIRM, TK_BTN_CONFIRM, TK_BTN_NONE},
    {TK_PIN_BTN_REJECT, TK_BTN_REJECT, TK_BTN_REJECT_LONG},
};

typedef struct {
    bool down;         // debounced state
    uint8_t diff;      // consecutive scans where the raw level differed from `down`
    uint32_t held_ms;  // time held since the debounced press
    bool ignore;       // pressed during a clip (or held across one): ignore until released
    bool long_fired;   // long press already reported for this hold
} btn_state_t;

typedef struct {
    uint8_t button; // tk_button_t
    uint32_t epoch;
} event_t;

static btn_state_t state[N_BTN];
static bool playing;
static uint32_t epoch;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static QueueHandle_t queue;
static esp_timer_handle_t timer;
static tk_chord_t chord;
static bool chord_pending;

static void scan(void *arg) {
    (void)arg;
    event_t out[N_BTN];
    int n_out = 0;

    taskENTER_CRITICAL(&lock);
    for (int i = 0; i < N_BTN; i++) {
        btn_state_t *s = &state[i];
        const btn_def_t *d = &DEFS[i];
        const bool raw = gpio_get_level(d->pin) == TK_BTN_ACTIVE_LEVEL;
        tk_button_t ev = TK_BTN_NONE;

        if (raw == s->down) {
            s->diff = 0;
        } else if (++s->diff >= DEBOUNCE_TICKS) {
            s->diff = 0;
            s->down = raw;
            if (s->down) { // press
                s->held_ms = 0;
                s->long_fired = false;
                s->ignore = playing;
                if (!s->ignore && d->long_press == TK_BTN_NONE) {
                    ev = d->press;
                }
            } else { // release
                if (!s->ignore && !s->long_fired && d->long_press != TK_BTN_NONE) {
                    ev = d->press;
                }
                s->ignore = false;
            }
        }

        if (s->down && raw == s->down) {
            s->held_ms += TK_BTN_SCAN_MS;
            if (!s->ignore && !s->long_fired && d->long_press != TK_BTN_NONE &&
                s->held_ms >= TK_BTN_LONG_MS) {
                s->long_fired = true;
                ev = d->long_press;
            }
        }

        if (ev != TK_BTN_NONE && !playing) {
            out[n_out++] = (event_t){.button = (uint8_t)ev, .epoch = epoch};
        }
    }
    const btn_state_t *ok = &state[BTN_OK], *back = &state[BTN_BACK];
    const bool both = !playing && ok->down && back->down && !ok->ignore && !back->ignore;
    if (tk_chord_step(&chord, both, TK_BTN_SCAN_MS)) {
        chord_pending = true;
    }
    taskEXIT_CRITICAL(&lock);

    // Outside the critical section. If a clip started meanwhile, the epoch moved on and
    // wait_button drops these.
    for (int i = 0; i < n_out; i++) {
        (void)xQueueSend(queue, &out[i], 0); // queue full: drop the newest
    }
}

bool tk_buttons_init(void) {
    gpio_config_t cfg = {
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    for (int i = 0; i < N_BTN; i++) {
        cfg.pin_bit_mask |= 1ULL << DEFS[i].pin;
    }
    if (gpio_config(&cfg) != ESP_OK) {
        return false;
    }
    // Start from the real levels, so a button held at boot doesn't report a press.
    for (int i = 0; i < N_BTN; i++) {
        state[i].down = gpio_get_level(DEFS[i].pin) == TK_BTN_ACTIVE_LEVEL;
        state[i].ignore = state[i].down;
    }

    queue = xQueueCreate(QUEUE_LEN, sizeof(event_t));
    if (queue == NULL) {
        return false;
    }
    const esp_timer_create_args_t targs = {.callback = scan, .name = "buttons"};
    if (esp_timer_create(&targs, &timer) != ESP_OK ||
        esp_timer_start_periodic(timer, TK_BTN_SCAN_MS * 1000u) != ESP_OK) {
        return false;
    }
    return true;
}

static uint32_t current_epoch(void) {
    taskENTER_CRITICAL(&lock);
    const uint32_t e = epoch;
    taskEXIT_CRITICAL(&lock);
    return e;
}

tk_button_t tk_buttons_wait(uint32_t timeout_ms) {
    if (queue == NULL) { // init failed: no presses, but keep the caller's timing
        vTaskDelay(pdMS_TO_TICKS(timeout_ms));
        return TK_BTN_NONE;
    }
    const TickType_t start = xTaskGetTickCount();
    const TickType_t total = pdMS_TO_TICKS(timeout_ms);
    for (;;) {
        const TickType_t elapsed = xTaskGetTickCount() - start;
        if (elapsed > total) {
            return TK_BTN_NONE;
        }
        event_t e;
        if (xQueueReceive(queue, &e, total - elapsed) != pdTRUE) {
            return TK_BTN_NONE;
        }
        if (e.epoch == current_epoch()) {
            return (tk_button_t)e.button;
        }
        // From before or during a clip: drop it and keep waiting.
    }
}

static void clip_edge(bool now_playing) {
    taskENTER_CRITICAL(&lock);
    playing = now_playing;
    epoch++;
    for (int i = 0; i < N_BTN; i++) {
        if (state[i].down) {
            state[i].ignore = true;
        }
    }
    tk_chord_reset(&chord);
    chord_pending = false;
    taskEXIT_CRITICAL(&lock);
    if (queue != NULL) {
        xQueueReset(queue);
    }
}

void tk_buttons_clip_start(void) {
    clip_edge(true);
}

void tk_buttons_clip_end(void) {
    clip_edge(false);
}

bool tk_buttons_take_chord(void) {
    taskENTER_CRITICAL(&lock);
    const bool pending = chord_pending;
    chord_pending = false;
    taskEXIT_CRITICAL(&lock);
    return pending;
}

bool tk_buttons_any_down(void) {
    bool any = false;
    taskENTER_CRITICAL(&lock);
    for (int i = 0; i < N_BTN; i++) {
        any = any || state[i].down;
    }
    taskEXIT_CRITICAL(&lock);
    return any;
}

const char *tk_button_name(tk_button_t b) {
    switch (b) {
    case TK_BTN_NONE: return "NONE";
    case TK_BTN_UP: return "UP";
    case TK_BTN_DOWN: return "DOWN";
    case TK_BTN_OK: return "OK";
    case TK_BTN_BACK: return "BACK";
    case TK_BTN_CONFIRM: return "CONFIRM";
    case TK_BTN_REJECT: return "REJECT";
    case TK_BTN_OK_LONG: return "OK_LONG";
    case TK_BTN_REJECT_LONG: return "REJECT_LONG";
    }
    return "?";
}
