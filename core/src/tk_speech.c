#include "tk_speech.h"

#include "tk_clips.h"

typedef struct {
    uint16_t *clips;
    size_t cap;
    size_t n;
    int overflow;
} out_t;

static void put(out_t *o, uint16_t clip) {
    if (o->n < o->cap) {
        o->clips[o->n++] = clip;
    } else {
        o->overflow = 1;
    }
}

// 0 < v < 1000
static void say_below_thousand(out_t *o, unsigned v) {
    if (v >= 100) {
        put(o, (uint16_t)(TK_CLIP_ZERO + v / 100));
        put(o, TK_CLIP_HUNDRED);
        v %= 100;
    }
    if (v >= 20) {
        put(o, (uint16_t)(TK_CLIP_TWENTY + (v / 10 - 2)));
        v %= 10;
    }
    if (v > 0) {
        put(o, (uint16_t)(TK_CLIP_ZERO + v));
    }
}

static void say_whole(out_t *o, uint64_t v) {
    if (v == 0) {
        put(o, TK_CLIP_ZERO);
        return;
    }
    static const struct {
        uint64_t scale;
        uint16_t clip;
    } scales[] = {
        {UINT64_C(1000000000000), TK_CLIP_TRILLION},
        {UINT64_C(1000000000), TK_CLIP_BILLION},
        {UINT64_C(1000000), TK_CLIP_MILLION},
        {UINT64_C(1000), TK_CLIP_THOUSAND},
    };
    // v <= u64 max / 10^6 < 10^15, so the trillions group is below 1000 too.
    for (size_t i = 0; i < sizeof(scales) / sizeof(scales[0]); i++) {
        const uint64_t group = v / scales[i].scale;
        if (group > 0) {
            say_below_thousand(o, (unsigned)group);
            put(o, scales[i].clip);
            v %= scales[i].scale;
        }
    }
    if (v > 0) {
        say_below_thousand(o, (unsigned)v);
    }
}

size_t tk_speech_amount(tk_tx_kind_t kind, uint64_t amount, uint16_t *clips, size_t cap) {
    unsigned decimals;
    if (kind == TK_TX_SOL) {
        decimals = 9;
    } else if (kind == TK_TX_USDC) {
        decimals = 6;
    } else {
        return 0;
    }
    if (clips == NULL) {
        return 0;
    }
    uint64_t scale = 1;
    for (unsigned i = 0; i < decimals; i++) {
        scale *= 10;
    }
    out_t o = {clips, cap, 0, 0};
    say_whole(&o, amount / scale);
    uint64_t frac = amount % scale;
    if (frac > 0) {
        put(&o, TK_CLIP_POINT);
        uint64_t div = scale / 10;
        while (frac > 0) {
            put(&o, (uint16_t)(TK_CLIP_ZERO + frac / div));
            frac %= div;
            div /= 10;
        }
    }
    return o.overflow ? 0 : o.n;
}

size_t tk_speech_spell(const char *name, size_t len, uint16_t *clips, size_t cap) {
    if (name == NULL || clips == NULL) {
        return 0;
    }
    out_t o = {clips, cap, 0, 0};
    for (size_t i = 0; i < len; i++) {
        const char ch = name[i];
        if (ch >= 'A' && ch <= 'Z') {
            put(&o, (uint16_t)(TK_CLIP_LETTER_A + (ch - 'A')));
        } else if (ch >= 'a' && ch <= 'z') {
            put(&o, (uint16_t)(TK_CLIP_LETTER_A + (ch - 'a')));
        } else if (ch >= '0' && ch <= '9') {
            put(&o, (uint16_t)(TK_CLIP_ZERO + (ch - '0')));
        } else if (ch == ' ') {
            put(&o, TK_CLIP_SPACE);
        } else if (ch == '-') {
            put(&o, TK_CLIP_HYPHEN);
        } else if (ch == '\'') {
            put(&o, TK_CLIP_APOSTROPHE);
        } else {
            return 0;
        }
    }
    return o.overflow ? 0 : o.n;
}
