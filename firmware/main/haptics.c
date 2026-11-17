// DRV2605L haptic driver: ESP-IDF I2C master driver, internal trigger, ERM open loop, effect
// library A. Register numbers are from the TI DRV2605L datasheet (SLOS854).
//
// Playback is fire-and-forget: load the waveform sequencer, set GO, return. Every I2C transfer has
// a short timeout, so a missing or stuck chip never holds up a flow.

#include "haptics.h"

#include "driver/i2c_master.h"

#include "tk_pins.h"

#define I2C_HZ 100000
#define XFER_TIMEOUT_MS 20

// Registers.
#define REG_STATUS 0x00
#define REG_MODE 0x01
#define REG_RTP 0x02
#define REG_LIBRARY 0x03
#define REG_WAVESEQ1 0x04 // ..0x0B, 8 slots, 0 ends the sequence
#define REG_GO 0x0C
#define REG_OVERDRIVE 0x0D // ..0x10: overdrive, sustain +/-, brake time offsets
#define REG_FEEDBACK 0x1A
#define REG_CONTROL3 0x1D

#define MODE_INTERNAL_TRIGGER 0x00 // also clears STANDBY (bit 6)
#define LIBRARY_ERM_A 0x01
#define FEEDBACK_N_ERM_LRA 0x80 // 0 = ERM
#define CONTROL3_ERM_OPEN_LOOP 0x20
#define SEQ_SLOTS 8
#define WAIT(ms10) (uint8_t)(0x80 | (ms10)) // sequencer wait, in 10 ms units

// Effects from library A (datasheet table 11.2). Tuned by feel on the device.
#define FX_STRONG_CLICK 1
#define FX_STRONG_BUZZ 14
#define FX_ALERT_750MS 15

static const uint8_t SEQ[4][SEQ_SLOTS] = {
    [TK_HAPTIC_TICK] = {FX_STRONG_CLICK},
    // Double pulse with a longer second pulse (two clicks back to back), easier to feel than
    // library effect 10 (Double Click).
    [TK_HAPTIC_SUCCESS] = {FX_STRONG_CLICK, WAIT(10), FX_STRONG_CLICK, FX_STRONG_CLICK},
    [TK_HAPTIC_REJECT] = {FX_ALERT_750MS},
    [TK_HAPTIC_WARNING] = {FX_STRONG_BUZZ, WAIT(15), FX_STRONG_BUZZ, WAIT(15), FX_STRONG_BUZZ},
};

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t dev;
static tk_haptics_status_t status;

static bool reg_write(uint8_t reg, uint8_t val) {
    const uint8_t b[2] = {reg, val};
    return i2c_master_transmit(dev, b, sizeof(b), XFER_TIMEOUT_MS) == ESP_OK;
}

static bool reg_read(uint8_t reg, uint8_t *val) {
    return i2c_master_transmit_receive(dev, &reg, 1, val, 1, XFER_TIMEOUT_MS) == ESP_OK;
}

static bool chip_setup(void) {
    uint8_t st = 0, fb = 0, c3 = 0;
    if (!reg_read(REG_STATUS, &st)) {
        return false;
    }
    status.chip_id = (uint8_t)(st >> 5);
    if (status.chip_id != 7 && status.chip_id != 3) {
        return false;
    }
    if (!reg_write(REG_MODE, MODE_INTERNAL_TRIGGER) || !reg_write(REG_RTP, 0) ||
        !reg_write(REG_LIBRARY, LIBRARY_ERM_A)) {
        return false;
    }
    for (uint8_t r = REG_OVERDRIVE; r <= REG_OVERDRIVE + 3; r++) {
        if (!reg_write(r, 0)) {
            return false;
        }
    }
    return reg_read(REG_FEEDBACK, &fb) && reg_write(REG_FEEDBACK, (uint8_t)(fb & ~FEEDBACK_N_ERM_LRA)) &&
           reg_read(REG_CONTROL3, &c3) && reg_write(REG_CONTROL3, (uint8_t)(c3 | CONTROL3_ERM_OPEN_LOOP));
}

bool tk_haptics_init(void) {
    const i2c_master_bus_config_t bc = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = TK_PIN_I2C_SDA,
        .scl_io_num = TK_PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true, // the board's 10k pull-ups do the real work
    };
    status.bus_ok = i2c_new_master_bus(&bc, &bus) == ESP_OK;
    if (!status.bus_ok) {
        return false;
    }
    status.chip_found = i2c_master_probe(bus, TK_HAPTICS_ADDR, XFER_TIMEOUT_MS) == ESP_OK;
    if (!status.chip_found) {
        return false;
    }
    const i2c_device_config_t dc = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = TK_HAPTICS_ADDR,
        .scl_speed_hz = I2C_HZ,
    };
    if (i2c_master_bus_add_device(bus, &dc, &dev) != ESP_OK) {
        return false;
    }
    status.ready = chip_setup();
    return status.ready;
}

void tk_haptics_play(tk_haptic_t pattern) {
    if (!status.ready || (unsigned)pattern >= sizeof(SEQ) / sizeof(SEQ[0])) {
        return;
    }
    if (!reg_write(REG_GO, 0)) { // stop whatever is still playing
        return;
    }
    for (uint8_t i = 0; i < SEQ_SLOTS; i++) {
        if (!reg_write((uint8_t)(REG_WAVESEQ1 + i), SEQ[pattern][i])) {
            return;
        }
    }
    (void)reg_write(REG_GO, 1);
}

tk_haptics_status_t tk_haptics_status(void) {
    return status;
}

const char *tk_haptics_name(tk_haptic_t pattern) {
    switch (pattern) {
    case TK_HAPTIC_TICK: return "TICK";
    case TK_HAPTIC_SUCCESS: return "SUCCESS";
    case TK_HAPTIC_REJECT: return "REJECT";
    case TK_HAPTIC_WARNING: return "WARNING";
    }
    return "?";
}

bool tk_haptics_probe(uint8_t addr) {
    return status.bus_ok && i2c_master_probe(bus, addr, XFER_TIMEOUT_MS) == ESP_OK;
}
