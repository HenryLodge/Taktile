// Hardware bring-up menu. Built only with CONFIG_TK_BRINGUP (sdkconfig.bringup): the console is on
// the USB port, so use `idf.py monitor`. Never ship this build.

#include "sdkconfig.h"

#if CONFIG_TK_BRINGUP

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "audio.h"
#include "bringup.h"
#include "buttons.h"
#include "platform.h"
#include "tk_clips.h"
#include "rng.h"
#include "tk_device.h"
#include "tk_pins.h"

// Formats and writes straight to the USB-Serial-JTAG driver. Deliberately not printf/stdout: that
// needs the vfs component, which drags the UART and PSRAM drivers into the build.
__attribute__((format(printf, 1, 2))) static void out(const char *fmt, ...) {
    char line[768]; // longest output is the menu; longer text is cut off with "..."
    va_list ap;
    va_start(ap, fmt);
    const int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n <= 0) {
        return;
    }
    size_t len = (size_t)n;
    if (len >= sizeof(line)) {
        len = sizeof(line) - 1;
        memcpy(line + len - 4, "...\n", 4);
    }
    for (size_t at = 0; at < len;) {
        const int w = usb_serial_jtag_write_bytes(line + at, len - at, pdMS_TO_TICKS(100));
        if (w <= 0) {
            return; // host not reading: drop the rest
        }
        at += (size_t)w;
    }
}

static void menu(void) {
    out("\nTaktile bring-up (fw 0x%04x). Pick a step:\n"
        "  1  blink the red LED + echo what you type\n"
        "  2  RNG: health check + sample\n"
        "  3  buttons: print every press (any key returns to the menu)\n"
        "  4  tone: 440 Hz on the earpiece, then on the speaker; then the RNG check again\n"
        "  5  clips: pack status, then words on the earpiece and one on the speaker\n"
        "  6  discard test: CONFIRM during a clip must not count\n"
        "  7  SPK_EN check: loud tone with the speaker OFF, then ON; pin level read back\n"
        "Reset the board to come back here.\n",
        TK_FW_VERSION);
}

// Reads one byte, waiting up to timeout_ms. Returns -1 on timeout.
static int read_byte(uint32_t timeout_ms) {
    uint8_t c;
    return usb_serial_jtag_read_bytes(&c, 1, pdMS_TO_TICKS(timeout_ms)) == 1 ? c : -1;
}

// Step 1 (HARDWARE.md bring-up 1): LED toggles every 500 ms; every byte typed comes straight back.
static void step_blink_echo(void) {
    const gpio_config_t led = {
        .pin_bit_mask = 1ULL << TK_PIN_LED,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&led));
    out("step 1: LED on GPIO%d blinks at 1 Hz; type and each key is echoed.\n", TK_PIN_LED);

    int level = 0;
    int64_t next = esp_timer_get_time();
    uint8_t buf[64];
    for (;;) {
        if (esp_timer_get_time() >= next) {
            level = !level;
            gpio_set_level(TK_PIN_LED, (uint32_t)level);
            next += 500 * 1000;
        }
        const int n = usb_serial_jtag_read_bytes(buf, sizeof(buf), pdMS_TO_TICKS(10));
        if (n > 0) {
            usb_serial_jtag_write_bytes(buf, (size_t)n, pdMS_TO_TICKS(50));
        }
    }
}

// Step 2 (HARDWARE.md bring-up 2): entropy source state, a sample, and rough statistics over 64 KB.
// The bytes drawn here are thrown away; this build never holds a key.
static void step_rng(void) {
    const tk_rng_status_t st = tk_rng_status();
    out("step 2: entropy source %s, startup test %s, continuous test %s\n",
        st.entropy_on ? "ON" : "OFF", st.startup_ok ? "PASS" : "FAIL",
        st.cont_failed ? "TRIPPED" : "ok");

    uint8_t sample[32];
    if (!tk_rng_fill(sample, sizeof(sample))) {
        out("RNG REFUSED (fail closed)\nstep 2: FAIL\n");
        return;
    }
    out("sample: ");
    for (size_t i = 0; i < sizeof(sample); i++) {
        out("%02x", sample[i]);
    }
    out("\n");

    enum { TOTAL = 64 * 1024 };
    static uint32_t hist[256];
    memset(hist, 0, sizeof(hist));
    uint8_t buf[256];
    uint32_t ones = 0, run = 1, longest = 1;
    int prev = -1;
    const int64_t t0 = esp_timer_get_time();
    for (size_t done = 0; done < TOTAL; done += sizeof(buf)) {
        if (!tk_rng_fill(buf, sizeof(buf))) {
            out("RNG REFUSED during the run (continuous test tripped)\nstep 2: FAIL\n");
            return;
        }
        for (size_t i = 0; i < sizeof(buf); i++) {
            hist[buf[i]]++;
            ones += (uint32_t)__builtin_popcount(buf[i]);
            run = (buf[i] == prev) ? run + 1 : 1;
            longest = run > longest ? run : longest;
            prev = buf[i];
        }
    }
    const int64_t us = esp_timer_get_time() - t0;

    double chi = 0;
    const double expect = TOTAL / 256.0;
    for (int i = 0; i < 256; i++) {
        const double d = (double)hist[i] - expect;
        chi += d * d / expect;
    }
    const double frac = ones / (TOTAL * 8.0);
    const bool ok = frac > 0.49 && frac < 0.51 && chi < 330 && longest <= 4;
    out("64 KB: ones %.4f (want 0.49-0.51), chi-square %.1f (want ~255, < 330), longest run %u "
        "(want <= 4), %lld KB/s\n",
        frac, chi, (unsigned)longest, (long long)(TOTAL / 1024 * 1000000LL / (us ? us : 1)));
    out("step 2: %s\n", ok ? "PASS" : "FAIL");
}

// Step 3 (HARDWARE.md bring-up 3): every debounced event with its time; the LED is lit while any
// button is down. Any key on the console returns to the menu.
static void step_buttons(void) {
    const gpio_config_t led = {.pin_bit_mask = 1ULL << TK_PIN_LED, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&led));
    out("step 3: press each button. Short presses: UP DOWN OK BACK CONFIRM REJECT. Hold OK or\n"
        "REJECT for %u ms for a long press. Any key here returns to the menu.\n", TK_BTN_LONG_MS);
    for (;;) {
        const tk_button_t b = tk_buttons_wait(20);
        gpio_set_level(TK_PIN_LED, tk_buttons_any_down() ? 1 : 0);
        if (b != TK_BTN_NONE) {
            out("BTN %s t=%lld ms\n", tk_button_name(b), (long long)(esp_timer_get_time() / 1000));
        }
        uint8_t c;
        if (usb_serial_jtag_read_bytes(&c, 1, 0) == 1) {
            gpio_set_level(TK_PIN_LED, 0);
            out("step 3: done\n");
            return;
        }
    }
}

static void wait_ms(uint32_t ms) {
    vTaskDelay(pdMS_TO_TICKS(ms));
}

// Step 4 (HARDWARE.md bring-up 4): tone on the earpiece only (SPK_EN LOW), then on the speaker
// (SPK_EN HIGH), then the RNG check again with I2S running (risk R4: entropy source vs I2S).
static void step_tone(void) {
    const tk_audio_status_t st = tk_audio_status();
    out("step 4: I2S %s\n", st.i2s_ok ? "ok" : "FAILED");
    if (!st.i2s_ok) {
        out("step 4: FAIL\n");
        return;
    }
    out("tone 440 Hz, 2 s, EARPIECE ONLY (the speaker must stay silent)...\n");
    tk_audio_tone(440, 2000, false);
    wait_ms(1000);
    out("tone 440 Hz, 2 s, SPEAKER (and earpiece)...\n");
    tk_audio_tone(440, 2000, true);
    out("tone done; speaker off again. RNG check with I2S running:\n");
    step_rng();
}

static const char *pack_err_name(tk_clippack_err_t e) {
    switch (e) {
    case TK_CLIPPACK_OK: return "OK";
    case TK_CLIPPACK_TOO_SHORT: return "TOO_SHORT (missing or truncated)";
    case TK_CLIPPACK_BAD_MAGIC: return "BAD_MAGIC (nothing flashed?)";
    case TK_CLIPPACK_BAD_VERSION: return "BAD_VERSION";
    case TK_CLIPPACK_WRONG_COUNT: return "WRONG_COUNT (stale pack)";
    case TK_CLIPPACK_WRONG_FINGERPRINT: return "WRONG_FINGERPRINT (stale pack)";
    case TK_CLIPPACK_BAD_ENTRY: return "BAD_ENTRY";
    case TK_CLIPPACK_BAD_CRC: return "BAD_CRC";
    }
    return "?";
}

// Step 5 (HARDWARE.md bring-up 5): clip pack status, then real clips. Bring-up only: these are
// test words, not secrets, so naming them here is fine.
static void step_clips(void) {
    const tk_audio_status_t st = tk_audio_status();
    out("step 5: partition %s, pack %s, %u bytes, %u clips expected\n",
        st.partition_found ? "found" : "MISSING", pack_err_name(st.pack), (unsigned)st.pack_len,
        (unsigned)TK_CLIP_COUNT);
    if (st.pack != TK_CLIPPACK_OK) {
        out("step 5: FAIL (flash tools/out/clips.bin, see firmware/README.md)\n");
        return;
    }
    out("earpiece: \"enter pin\", then zero..nine, then \"aardvark\" (speaker silent)\n");
    tk_audio_play(TK_CLIP_ENTER_PIN, false);
    for (uint16_t d = 0; d < 10; d++) {
        tk_audio_play((uint16_t)(TK_CLIP_ZERO + d), true); // secret: earpiece only
    }
    tk_audio_play(TK_CLIP_WORD_0, true);
    wait_ms(500);
    out("speaker mode on: \"speaker mode on\" (public) on the speaker, then \"seven\" (secret) on\n"
        "the earpiece ONLY\n");
    tk_audio_set_speaker_mode(true);
    tk_audio_play(TK_CLIP_SPEAKER_MODE_ON, false);
    tk_audio_play((uint16_t)(TK_CLIP_ZERO + 7), true);
    tk_audio_set_speaker_mode(false);
    out("step 5: done (listen: did each go where it should?)\n");
}

// Step 6: the platform's play_clip + wait_button, exactly as core calls them (I6).
static void step_discard(void) {
    const tk_platform_t *p = &TK_FW_PLATFORM;
    out("step 6, round 1: PRESS CONFIRM WHILE the clip is playing.\n");
    wait_ms(1500);
    p->play_clip(p->ctx, TK_CLIP_PRESS_CONFIRM, false);
    tk_button_t b = p->wait_button(p->ctx, 3000);
    out("round 1: wait_button -> %s (want NONE)\n", tk_button_name(b));
    const bool ok1 = b == TK_BTN_NONE;

    out("step 6, round 2: wait for the clip to END and the short beep, then press CONFIRM within 5 s.\n");
    wait_ms(1500);
    p->play_clip(p->ctx, TK_CLIP_PRESS_CONFIRM, false);
    tk_audio_tone(1320, 120, false); // "press now" cue; not a clip, so a press during it counts
    b = p->wait_button(p->ctx, 5000);
    out("round 2: wait_button -> %s (want CONFIRM)\n", tk_button_name(b));
    const bool ok2 = b == TK_BTN_CONFIRM;
    out("step 6: %s\n", ok1 && ok2 ? "PASS" : "FAIL");
}

// Step 7: does SPK_EN LOW really silence the speaker? A loud tone with SPK_EN LOW (speaker must be
// silent), then HIGH. The pad level is read back each time: if it reads 0 and the speaker still
// plays, SD isn't wired to SPK_EN's pin.
static void step_spk_check(void) {
    out("step 7: SPK_EN (GPIO%d) now reads %d\n", TK_PIN_SPK_EN, tk_audio_spk_pin());
    out("loud tone 2 s with SPK_EN LOW: the SPEAKER MUST BE SILENT\n");
    wait_ms(500);
    tk_audio_tone_spk_check(440, 2000, false);
    out("  after that tone SPK_EN reads %d (want 0)\n", tk_audio_spk_pin());
    wait_ms(1000);
    out("loud tone 2 s with SPK_EN HIGH: speaker plays\n");
    tk_audio_tone_spk_check(660, 2000, true);
    out("step 7: done; SPK_EN reads %d (want 0)\n", tk_audio_spk_pin());
}

void tk_bringup_main(void) {
    // From here on, all output goes through the driver (out() and the raw reads and writes), so
    // nothing fights over the hardware FIFO. Only the boot log before this point uses the ROM path.
    usb_serial_jtag_driver_config_t cfg = {.tx_buffer_size = 1024, .rx_buffer_size = 1024};
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));

    menu();
    for (;;) {
        const int c = read_byte(1000);
        switch (c) {
        case -1: break;
        case '1': step_blink_echo(); break; // does not return
        case '2': step_rng(); break;
        case '3': step_buttons(); break;
        case '4': step_tone(); break;
        case '5': step_clips(); break;
        case '6': step_discard(); break;
        case '7': step_spk_check(); break;
        default: menu(); break;
        }
    }
}

#endif
