#include "util.h"

#include <string.h>

static const char ALPHABET[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

bool sim_base58_decode32(const char *s, uint8_t out[32]) {
    uint8_t num[32] = {0}; // big-endian accumulator
    size_t len = strlen(s);
    if (len == 0 || len > 44) {
        return false;
    }
    size_t zeros = 0;
    while (zeros < len && s[zeros] == '1') {
        zeros++;
    }
    for (size_t i = 0; i < len; i++) {
        const char *p = strchr(ALPHABET, s[i]);
        if (p == NULL || s[i] == '\0') {
            return false;
        }
        uint32_t carry = (uint32_t)(p - ALPHABET);
        for (size_t j = 32; j-- > 0;) {
            carry += (uint32_t)num[j] * 58u;
            num[j] = (uint8_t)carry;
            carry >>= 8;
        }
        if (carry != 0) {
            return false; // more than 32 bytes
        }
    }
    // Leading '1's are leading zero bytes; the value's own leading zeros must match exactly.
    size_t lead = 0;
    while (lead < 32 && num[lead] == 0) {
        lead++;
    }
    if (lead != zeros && !(lead == 32 && zeros == 32)) {
        return false;
    }
    memcpy(out, num, 32);
    return true;
}

void sim_base58_encode32(const uint8_t in[32], char out[45]) {
    uint8_t digits[45] = {0}; // base58 digits, little-endian
    size_t ndig = 0;
    for (size_t i = 0; i < 32; i++) {
        uint32_t carry = in[i];
        for (size_t j = 0; j < ndig; j++) {
            carry += (uint32_t)digits[j] << 8;
            digits[j] = (uint8_t)(carry % 58);
            carry /= 58;
        }
        while (carry > 0) {
            digits[ndig++] = (uint8_t)(carry % 58);
            carry /= 58;
        }
    }
    size_t o = 0;
    for (size_t i = 0; i < 32 && in[i] == 0; i++) {
        out[o++] = '1';
    }
    for (size_t j = ndig; j-- > 0;) {
        out[o++] = ALPHABET[digits[j]];
    }
    out[o] = '\0';
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

bool sim_hex32(const char *s, uint8_t out[32]) {
    if (strlen(s) != 64) {
        return false;
    }
    for (size_t i = 0; i < 32; i++) {
        const int hi = hexval(s[2 * i]), lo = hexval(s[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[i] = (uint8_t)(hi * 16 + lo);
    }
    return true;
}

bool sim_parse_address(const char *s, uint8_t out[32]) {
    return strlen(s) == 64 ? sim_hex32(s, out) : sim_base58_decode32(s, out);
}

sim_key_kind_t sim_decode_key(const uint8_t *buf, size_t len, size_t *used, tk_button_t *button) {
    *used = 0;
    if (len == 0) {
        return SIM_KEY_NEED_MORE;
    }
    if (buf[0] == 0x1B) { // ESC [ A / ESC [ B (also ESC O A/B in application cursor mode)
        if (len < 3) {
            return SIM_KEY_NEED_MORE;
        }
        *used = 3;
        if ((buf[1] == '[' || buf[1] == 'O') && (buf[2] == 'A' || buf[2] == 'B')) {
            *button = buf[2] == 'A' ? TK_BTN_UP : TK_BTN_DOWN;
            return SIM_KEY_BUTTON;
        }
        return SIM_KEY_IGNORED;
    }
    *used = 1;
    switch (buf[0]) {
    case '\r':
    case '\n':
        *button = TK_BTN_OK;
        return SIM_KEY_BUTTON;
    case 0x7F:
    case 0x08:
        *button = TK_BTN_BACK;
        return SIM_KEY_BUTTON;
    case 'c':
        *button = TK_BTN_CONFIRM;
        return SIM_KEY_BUTTON;
    case 'r':
        *button = TK_BTN_REJECT;
        return SIM_KEY_BUTTON;
    case 'O':
        *button = TK_BTN_OK_LONG;
        return SIM_KEY_BUTTON;
    case 'R':
        *button = TK_BTN_REJECT_LONG;
        return SIM_KEY_BUTTON;
    case 'q':
        return SIM_KEY_QUIT;
    default:
        return SIM_KEY_IGNORED;
    }
}

// sim_clip_text() is generated from tools/clips.json: see clip_text.c (tools/gen-clips.mjs).
