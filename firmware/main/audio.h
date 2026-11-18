// Audio out: I2S0 to the UDA1334A earpiece DAC and the MAX98357A speaker amp (shared bus), SPK_EN
// routing, and clips from the clip pack in the `clips` partition (docs/AUDIO.md).

#ifndef TK_FW_AUDIO_H
#define TK_FW_AUDIO_H

#include <stdbool.h>
#include <stdint.h>

#include "tk_clippack.h"

#define TK_AUDIO_RATE_HZ 16000u

// Drives SPK_EN LOW (speaker amp shut down). Call right after tk_rng_start, before anything else:
// the amp board's own pull-up leaves the speaker on until we drive the pin.
void tk_audio_spk_off(void);

// Starts I2S and opens the clip pack (header, index and CRC checked). False if either failed; then
// every clip is silent (fail closed: nothing wrong is ever spoken).
bool tk_audio_init(void);

// Plays one clip and returns when it has finished. secret clips always go to the earpiece only:
// SPK_EN is driven LOW before any sample is written (decision #9, I2). Never logs the clip id.
void tk_audio_play(uint16_t clip, bool secret);

// Speaker ("demo") mode: public clips also play on the speaker. Off at boot (and only a reboot resets
// it); the device-only toggle is in main.c (OK + BACK held 3 s, between requests). Secret clips ignore it.
void tk_audio_set_speaker_mode(bool on);
bool tk_audio_speaker_mode(void);

typedef struct {
    bool i2s_ok;
    bool partition_found;
    tk_clippack_err_t pack; // TK_CLIPPACK_OK only if open and the CRC both passed
    uint32_t pack_len;
} tk_audio_status_t;

tk_audio_status_t tk_audio_status(void);

// Bring-up only: a sine tone, on the earpiece, or also on the speaker if speaker is true.
bool tk_audio_tone(uint32_t hz, uint32_t ms, bool speaker);

// Bring-up only: SPK_EN's real pad level (0 or 1), and a tone at the speaker's gain with SPK_EN
// set as given, to check that LOW really silences the speaker.
int tk_audio_spk_pin(void);
bool tk_audio_tone_spk_check(uint32_t hz, uint32_t ms, bool spk_en);

#endif
