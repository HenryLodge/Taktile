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
#include "haptics.h"
#include "platform.h"
#include "tk_clips.h"
#include "ed25519.h"
#include "esp_err.h"
#include "memzero.h"
#include "pbkdf2.h"
#include "rng.h"
#include "storage.h"
#include "tk_contacts.h"
#include "tk_device.h"
#include "tk_pins.h"
#include "tk_keystore.h"
#include "tk_seed.h"

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
        "  8  haptics: DRV2605L status, the four patterns, then a tone during a buzz\n"
        "  9  storage: NVS round-trips and refusals; boot counter (reset, run again: +1)\n"
        "  0  Ed25519: RFC 8032 known answer, signatures for the laptop to verify, timings\n"
        "  k  keys: BIP39 + SLIP-10 known answers on device, SETUP and unlock timings (no NVS)\n"
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

// Step 8 (HARDWARE.md bring-up 6): DRV2605L status, each pattern twice, then an earpiece tone
// while the motor buzzes to listen for motor noise in the audio.
static void step_haptics(void) {
    const tk_haptics_status_t st = tk_haptics_status();
    out("step 8: I2C bus %s, DRV2605L at 0x%02x %s, chip id %u (want 7), init %s\n",
        st.bus_ok ? "ok" : "FAILED", TK_HAPTICS_ADDR, st.chip_found ? "found" : "NOT FOUND",
        (unsigned)st.chip_id, st.ready ? "ok" : "FAILED");
    if (!st.ready) {
        out("  bus check: MAX17048 at 0x36 %s\nstep 8: FAIL (check VIN 3V3, GND, SDA, SCL)\n",
            tk_haptics_probe(0x36) ? "answers (bus ok, DRV2605L wiring?)" : "silent too");
        return;
    }
    for (int round = 1; round <= 2; round++) {
        for (int p = TK_HAPTIC_TICK; p <= TK_HAPTIC_WARNING; p++) {
            out("  %s\n", tk_haptics_name((tk_haptic_t)p));
            tk_haptics_play((tk_haptic_t)p);
            wait_ms(2000);
        }
    }
    out("  WARNING with a 440 Hz earpiece tone: listen for motor noise in the earbuds\n");
    tk_haptics_play(TK_HAPTIC_WARNING);
    tk_audio_tone(440, 2000, false);
    out("step 8: done (tell me how each pattern felt)\n");
}

static bool check(const char *what, bool ok) {
    out("  %-52s %s\n", what, ok ? "PASS" : "FAIL");
    return ok;
}

// Step 9 (HARDWARE.md bring-up 7): plain NVS through the platform's storage_get/set, exactly as
// core calls them. Test keys only (bu_*).
static void step_storage(void) {
    const tk_platform_t *p = &TK_FW_PLATFORM;
    const esp_err_t e = tk_storage_init_err();
    out("step 9: NVS %s (%s)\n", e == ESP_OK ? "open" : "OFF", esp_err_to_name(e));
    if (e != ESP_OK) {
        out("step 9: FAIL (never auto-erased; see firmware/README.md to erase it yourself)\n");
        return;
    }
    bool ok = true;

    static uint8_t a[TK_CONTACTS_BLOB_LEN], b[TK_CONTACTS_BLOB_LEN + 1];
    size_t n = 32;
    ok &= check("32 random bytes written", tk_rng_fill(a, 32) && p->storage_set(p->ctx, "bu_small", a, 32));
    n = sizeof(b);
    ok &= check("32 bytes read back equal",
                p->storage_get(p->ctx, "bu_small", b, &n) && n == 32 && memcmp(a, b, 32) == 0);

    ok &= check("contacts-sized blob written",
                tk_rng_fill(a, sizeof(a)) && p->storage_set(p->ctx, "bu_big", a, sizeof(a)));
    n = sizeof(b);
    ok &= check("contacts-sized blob read back equal",
                p->storage_get(p->ctx, "bu_big", b, &n) && n == sizeof(a) && memcmp(a, b, n) == 0);

    ok &= check("zero-length value written", p->storage_set(p->ctx, "bu_empty", NULL, 0));
    n = sizeof(b);
    ok &= check("zero-length value read back (present, len 0)",
                p->storage_get(p->ctx, "bu_empty", b, &n) && n == 0);

    n = sizeof(b);
    ok &= check("missing key refused", !p->storage_get(p->ctx, "bu_missing", b, &n));
    n = sizeof(a) - 1;
    ok &= check("buffer 1 byte too small refused", !p->storage_get(p->ctx, "bu_big", b, &n));
    ok &= check("16-character key refused", !p->storage_set(p->ctx, "bu_sixteen_chars", a, 1));
    ok &= check("bad character in key refused", !p->storage_set(p->ctx, "bu/x", a, 1));
    n = sizeof(b);
    ok &= check("15-character key accepted", p->storage_set(p->ctx, "bu_fifteen_chr", a, 1) &&
                                                 p->storage_get(p->ctx, "bu_fifteen_chr", b, &n) &&
                                                 n == 1);

    uint32_t boots = 0;
    n = sizeof(boots);
    const bool had = p->storage_get(p->ctx, "bu_boots", &boots, &n) && n == sizeof(boots);
    boots = had ? boots + 1 : 1;
    ok &= check("boot counter saved", p->storage_set(p->ctx, "bu_boots", &boots, sizeof(boots)));
    out("  boot counter is now %u. Press RESET, run step 9 again: it must read %u\n",
        (unsigned)boots, (unsigned)boots + 1);
    out("step 9: %s\n", ok ? "PASS" : "FAIL");
}

static void out_hex(const char *label, const uint8_t *b, size_t n) {
    out("%s", label);
    for (size_t i = 0; i < n; i++) {
        out("%02x", b[i]);
    }
}

static bool from_hex(const char *h, uint8_t *outb, size_t n) {
    for (size_t i = 0; i < n; i++) {
        unsigned v = 0;
        if (sscanf(h + 2 * i, "%2x", &v) != 1) {
            return false;
        }
        outb[i] = (uint8_t)v;
    }
    return h[2 * n] == '\0';
}

// Signs msg with sk and prints one line for tools/verify-ed25519.mjs. Never prints sk.
static void sign_line(const ed25519_secret_key sk, const ed25519_public_key pk, const uint8_t *msg,
                      size_t len) {
    ed25519_signature sig;
    ed25519_sign(msg, len, sk, sig);
    out_hex("ED25519 pub=", pk, 32);
    out_hex(" msg=", msg, len);
    out_hex(" sig=", sig, 64);
    out("\n");
}

// Step 10, menu key 0 (HARDWARE.md bring-up 8): trezor-crypto Ed25519 on the device. A known answer
// from RFC 8032, then signatures under a throwaway key for the laptop to verify with node:crypto,
// then timings for signing and PBKDF2 (sizes I7's iteration count).
static void step_ed25519(void) {
    // RFC 8032 section 7.1, TEST 1 (a published test key, empty message).
    static const char *RFC_SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    static const char *RFC_PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    static const char *RFC_SIG = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8"
                                 "821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    // tests/vectors/parser.json "sol_ok": a real devnet SOL transfer message (public test data).
    static const char *SOL_MSG =
        "01000103427ff53a173c8644ade89f73862e3c66e35d833aa0dfd47238a0dbffe0c766bc27e804b8011de010"
        "cd456a88075f05b9813deacc6c95eac51c6174f5624d7d5e00000000000000000000000000000000000000000"
        "00000000000000000000000338d11be117d524d4764e366fc30d19850d8270c2a512abe13480bb8db3fded101"
        "020200010c0200000060e3160000000000";

    bool ok = true;
    ed25519_secret_key sk;
    ed25519_public_key pk, want_pk;
    ed25519_signature sig, want_sig;
    ok &= from_hex(RFC_SK, sk, 32) && from_hex(RFC_PK, want_pk, 32) && from_hex(RFC_SIG, want_sig, 64);
    ed25519_publickey(sk, pk);
    ed25519_sign(NULL, 0, sk, sig);
    out("step 0 (Ed25519):\n");
    ok &= check("RFC 8032 test 1: public key", memcmp(pk, want_pk, 32) == 0);
    ok &= check("RFC 8032 test 1: signature", memcmp(sig, want_sig, 64) == 0);
    ok &= check("RFC 8032 test 1: signature verifies on device", ed25519_sign_open(NULL, 0, pk, sig) == 0);
    sig[0] ^= 1;
    ok &= check("flipped signature bit rejected on device", ed25519_sign_open(NULL, 0, pk, sig) != 0);

    // Throwaway key from the hardware RNG; this build never holds a real key.
    if (!tk_rng_fill(sk, sizeof(sk))) {
        out("RNG REFUSED\nstep 0: FAIL\n");
        return;
    }
    ed25519_publickey(sk, pk);
    out("lines for the laptop (pipe into: node tools/verify-ed25519.mjs):\n");
    uint8_t msg[24 + 32];
    memcpy(msg, "Taktile bring-up Ed25519", 24);
    ok &= tk_rng_fill(msg + 24, 32);
    sign_line(sk, pk, msg, sizeof(msg));
    static uint8_t sol[200];
    const size_t sol_len = strlen(SOL_MSG) / 2;
    ok &= check("Solana message decoded", sol_len <= sizeof(sol) && from_hex(SOL_MSG, sol, sol_len));
    sign_line(sk, pk, sol, sol_len);

    int64_t t0 = esp_timer_get_time();
    for (int i = 0; i < 10; i++) {
        ed25519_sign(sol, sol_len, sk, sig);
    }
    const int64_t sign_us = (esp_timer_get_time() - t0) / 10;
    memzero(sk, sizeof(sk));

    uint8_t key[32];
    static const uint8_t salt[16] = {0};
    t0 = esp_timer_get_time();
    pbkdf2_hmac_sha256((const uint8_t *)"123456", 6, salt, sizeof(salt), 10000, key, sizeof(key));
    const int64_t kdf_us = esp_timer_get_time() - t0;
    memzero(key, sizeof(key));
    out("  sign: %lld ms per %u-byte message; PBKDF2-HMAC-SHA256: %lld ms per 10,000 iterations\n"
        "  (100,000 iterations ~ %lld ms; I7 wants ~1 s)\n",
        (long long)(sign_us / 1000), (unsigned)sol_len, (long long)(kdf_us / 1000),
        (long long)(kdf_us / 100));
    out("step 0: %s on device; now check the ED25519 lines on the laptop\n", ok ? "PASS" : "FAIL");
}

// Step K: SETUP's key derivation on the device (core/src/tk_seed.c) against published test data,
// and the timings that size I7. Public test vectors only; never reads or writes NVS.
static void step_keys(void) {
    // trezor/python-mnemonic vector 0 (all-zero entropy, passphrase "TREZOR"); and the same
    // mnemonic with no passphrase at m/44'/501'/0'/0' (tests/vectors/seed.json "solana_0").
    static const char *SEED_TREZOR = "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd30971"
                                     "70af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8";
    static const char *SOLANA_PK = "20c821b6510834ae1c47084c6f61fd97864d5f12d731f95f4b06fe477b1efb45";
    out("step K (key derivation):\n");
    bool ok = true;
    uint8_t entropy[TK_SEED_ENTROPY_LEN] = {0};
    uint16_t idx[TK_SEED_WORDS];
    uint8_t seed[TK_SEED_LEN], want[TK_SEED_LEN], key[TK_SEED_KEY_LEN];
    ed25519_public_key pk, want_pk;
    ok &= check("all-zero entropy -> abandon ... art", tk_seed_words(entropy, idx) && idx[0] == 0 && idx[23] == 102);

    int64_t t0 = esp_timer_get_time();
    ok &= tk_seed_bip39(idx, "TREZOR", seed);
    const int64_t bip39_us = esp_timer_get_time() - t0;
    ok &= check("BIP39 seed (passphrase TREZOR) = published", from_hex(SEED_TREZOR, want, 64) && memcmp(seed, want, 64) == 0);

    ok &= tk_seed_bip39(idx, "", seed);
    t0 = esp_timer_get_time();
    ok &= tk_slip10_ed25519(seed, sizeof(seed), TK_SOLANA_PATH, TK_SOLANA_PATH_LEN, key);
    const int64_t slip_us = esp_timer_get_time() - t0;
    ed25519_publickey(key, pk);
    ok &= check("m/44'/501'/0'/0' public key = web3.js", from_hex(SOLANA_PK, want_pk, 32) && memcmp(pk, want_pk, 32) == 0);
    memzero(seed, sizeof(seed));
    memzero(key, sizeof(key));

    // PBKDF2-HMAC-SHA256 at the key store's count: one 32-byte block, and the 64 bytes the key
    // store really derives (two blocks: Kenc and Kmac, core/src/tk_keystore.c).
    static const uint8_t salt[16] = {0};
    uint8_t k64[64];
    t0 = esp_timer_get_time();
    pbkdf2_hmac_sha256((const uint8_t *)"123456", 6, salt, sizeof(salt), TK_KDF_ITERS, key, sizeof(key));
    const int64_t kdf_us = esp_timer_get_time() - t0;
    t0 = esp_timer_get_time();
    pbkdf2_hmac_sha256((const uint8_t *)"123456", 6, salt, sizeof(salt), TK_KDF_ITERS, k64, sizeof(k64));
    const int64_t kdf64_us = esp_timer_get_time() - t0;
    memzero(key, sizeof(key));
    memzero(k64, sizeof(k64));
    out("  BIP39 seed (2048 x PBKDF2-HMAC-SHA512): %lld ms; SLIP-10 (4 levels): %lld ms\n"
        "  PBKDF2-HMAC-SHA256, %u iterations: 32 bytes %lld ms; 64 bytes (key store: unlock and\n"
        "  SETUP commit) %lld ms\n",
        (long long)(bip39_us / 1000), (long long)(slip_us / 1000), (unsigned)TK_KDF_ITERS,
        (long long)(kdf_us / 1000), (long long)(kdf64_us / 1000));
    out("step K: %s\n", ok ? "PASS" : "FAIL");
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
        case '8': step_haptics(); break;
        case '9': step_storage(); break;
        case '0': step_ed25519(); break;
        case 'k':
        case 'K': step_keys(); break;
        default: menu(); break;
        }
    }
}

#endif
