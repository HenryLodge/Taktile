// Audio: I2S0, Philips, 16-bit stereo at 16 kHz, no MCLK. Clips are mono; each sample goes to both
// channels (the UDA1334A plays both, the MAX98357A with SD driven HIGH plays the left one).
//
// SPK_EN (MAX98357A SD) is LOW except while a public clip plays in speaker mode. A secret clip
// drives it LOW before its first sample is written (decision #9, I2), and every clip ends with
// enough silence to drain the DMA buffers, so audio never spills into the next clip's routing.
//
// The clip pack is mapped from the `clips` partition and checked once at init (header, every index
// entry, CRC; core/src/tk_clippack.c). If anything fails, clips are silent: fail closed.

#include "audio.h"

#include <math.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_partition.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "buttons.h"
#include "tk_clips.h"
#include "tk_clips_fp.h"
#include "tk_pins.h"

#define PARTITION_SUBTYPE 0x40 // `clips` in partitions.csv
#define CHUNK 256              // mono samples per I2S write
#define DMA_DESC 6
#define DMA_FRAMES 240
#define WRITE_TIMEOUT_MS 1000

// Gains, Q15, tuned by ear on the device (2026-11-16). Clips are peak-normalized to -3 dBFS.
// Earpiece only: -9 dB (0.355); full scale is too loud straight into earbuds. Speaker on: 50%
// (-6 dB); 100% was too loud and crackled, and 75% was also judged worse by ear. Both outputs
// share the bus, so while the speaker is on the earbuds get the louder level too; secret clips
// never turn the speaker on, so they always play at the earpiece level.
#define GAIN_EARPIECE_Q15 11627
#define GAIN_SPEAKER_Q15 16423
#define SPK_SETTLE_MS 10 // after turning the amp on, before its first sample

static i2s_chan_handle_t tx;
static bool speaker_mode;
static int32_t gain_q15 = GAIN_EARPIECE_Q15; // set by route()
static tk_clippack_t pack;
static tk_audio_status_t status = {.pack = TK_CLIPPACK_TOO_SHORT};

void tk_audio_spk_off(void) {
    // INPUT_OUTPUT so the pad's real level can be read back (bring-up step 7).
    const gpio_config_t cfg = {.pin_bit_mask = 1ULL << TK_PIN_SPK_EN, .mode = GPIO_MODE_INPUT_OUTPUT};
    gpio_set_level(TK_PIN_SPK_EN, 0); // latch LOW before the pin becomes an output
    (void)gpio_config(&cfg);
    gpio_set_level(TK_PIN_SPK_EN, 0);
}

static bool i2s_start(void) {
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan.dma_desc_num = DMA_DESC;
    chan.dma_frame_num = DMA_FRAMES;
    chan.auto_clear_after_cb = true; // send zeros when we have nothing to play
    if (i2s_new_channel(&chan, &tx, NULL) != ESP_OK) {
        return false;
    }
    const i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(TK_AUDIO_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = TK_PIN_I2S_BCLK,
            .ws = TK_PIN_I2S_WS,
            .dout = TK_PIN_I2S_DOUT,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
        },
    };
    if (i2s_channel_init_std_mode(tx, &std) != ESP_OK || i2s_channel_enable(tx) != ESP_OK) {
        tx = NULL;
        return false;
    }
    return true;
}

static void pack_open(void) {
    const esp_partition_t *part =
        esp_partition_find_first(ESP_PARTITION_TYPE_DATA, PARTITION_SUBTYPE, "clips");
    status.partition_found = part != NULL;
    if (part == NULL) {
        return;
    }
    uint8_t hdr[TK_CLIPPACK_HEADER_LEN];
    uint32_t total = 0;
    if (esp_partition_read(part, 0, hdr, sizeof(hdr)) != ESP_OK) {
        return;
    }
    status.pack = tk_clippack_total_len(hdr, sizeof(hdr), &total);
    if (status.pack != TK_CLIPPACK_OK) {
        return;
    }
    if (total < TK_CLIPPACK_HEADER_LEN || total > part->size) {
        status.pack = TK_CLIPPACK_TOO_SHORT;
        return;
    }
    const void *map = NULL;
    esp_partition_mmap_handle_t handle;
    if (esp_partition_mmap(part, 0, total, ESP_PARTITION_MMAP_DATA, &map, &handle) != ESP_OK) {
        status.pack = TK_CLIPPACK_TOO_SHORT;
        return;
    }
    tk_clippack_t p;
    status.pack = tk_clippack_open(&p, map, total, TK_CLIP_COUNT, TK_CLIPS_FINGERPRINT);
    if (status.pack == TK_CLIPPACK_OK) {
        status.pack = tk_clippack_verify_crc(&p);
    }
    if (status.pack == TK_CLIPPACK_OK) {
        pack = p;
        status.pack_len = p.len;
    } else {
        esp_partition_munmap(handle);
    }
}

bool tk_audio_init(void) {
    status.i2s_ok = i2s_start();
    pack_open();
    return status.i2s_ok && status.pack == TK_CLIPPACK_OK;
}

// Called only between clips (the previous one has drained), so the gain never changes mid-sound.
static void route(bool speaker) {
    static bool on;
    gain_q15 = speaker ? GAIN_SPEAKER_Q15 : GAIN_EARPIECE_Q15;
    gpio_set_level(TK_PIN_SPK_EN, speaker ? 1 : 0);
    if (speaker && !on) {
        vTaskDelay(pdMS_TO_TICKS(SPK_SETTLE_MS)); // let the amp start before audio reaches it
    }
    on = speaker;
}

static bool write_stereo(const int16_t *mono, size_t n) {
    int16_t st[2 * CHUNK];
    for (size_t i = 0; i < n; i++) {
        const int16_t s = mono ? (int16_t)(((int32_t)mono[i] * gain_q15) >> 15) : 0;
        st[2 * i] = s;
        st[2 * i + 1] = s;
    }
    size_t written = 0;
    return i2s_channel_write(tx, st, n * 2 * sizeof(int16_t), &written, WRITE_TIMEOUT_MS) == ESP_OK &&
           written == n * 2 * sizeof(int16_t);
}

// Enough zeros to push every real sample out of the DMA buffers before we return.
static void drain(void) {
    for (size_t left = DMA_DESC * DMA_FRAMES; left > 0;) {
        const size_t n = left < CHUNK ? left : CHUNK;
        if (!write_stereo(NULL, n)) {
            return;
        }
        left -= n;
    }
}

void tk_audio_play(uint16_t clip, bool secret) {
    route(!secret && speaker_mode); // before any sample of this clip is written
    tk_buttons_clip_start();

    const uint8_t *pcm = NULL;
    const uint32_t bytes = tx != NULL ? tk_clippack_get(&pack, clip, &pcm) : 0;
    const size_t samples = bytes / 2;
    int16_t mono[CHUNK];
    bool ok = true;
    for (size_t at = 0; ok && at < samples;) {
        const size_t n = samples - at < CHUNK ? samples - at : CHUNK;
        for (size_t i = 0; i < n; i++) {
            const uint8_t *b = pcm + 2 * (at + i);
            mono[i] = (int16_t)(uint16_t)(b[0] | (b[1] << 8));
        }
        ok = write_stereo(mono, n);
        at += n;
    }
    if (tx != NULL) {
        drain();
    }

    route(false);
    tk_buttons_clip_end();
}

void tk_audio_set_speaker_mode(bool on) {
    speaker_mode = on;
}

tk_audio_status_t tk_audio_status(void) {
    return status;
}

int tk_audio_spk_pin(void) {
    return gpio_get_level(TK_PIN_SPK_EN);
}

bool tk_audio_tone_spk_check(uint32_t hz, uint32_t ms, bool spk_en) {
    if (tx == NULL) {
        return false;
    }
    route(spk_en);
    gain_q15 = GAIN_SPEAKER_Q15; // loud either way, so a leak through the speaker is obvious
    int16_t mono[CHUNK];
    const size_t total = (size_t)TK_AUDIO_RATE_HZ * ms / 1000u;
    const float step = 2.0f * (float)M_PI * (float)hz / (float)TK_AUDIO_RATE_HZ;
    bool ok = true;
    for (size_t at = 0; ok && at < total;) {
        const size_t n = total - at < CHUNK ? total - at : CHUNK;
        for (size_t i = 0; i < n; i++) {
            mono[i] = (int16_t)(sinf(step * (float)(at + i)) * 23197.0f);
        }
        ok = write_stereo(mono, n);
        at += n;
    }
    drain();
    route(false);
    return ok;
}

bool tk_audio_tone(uint32_t hz, uint32_t ms, bool speaker) {
    if (tx == NULL) {
        return false;
    }
    route(speaker);
    int16_t mono[CHUNK];
    const size_t total = (size_t)TK_AUDIO_RATE_HZ * ms / 1000u;
    const float step = 2.0f * (float)M_PI * (float)hz / (float)TK_AUDIO_RATE_HZ;
    bool ok = true;
    for (size_t at = 0; ok && at < total;) {
        const size_t n = total - at < CHUNK ? total - at : CHUNK;
        for (size_t i = 0; i < n; i++) {
            mono[i] = (int16_t)(sinf(step * (float)(at + i)) * 23197.0f); // -3 dBFS, like the clips
        }
        ok = write_stereo(mono, n);
        at += n;
    }
    drain();
    route(false);
    return ok;
}
