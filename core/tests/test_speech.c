// Amount and name speech: clip sequences rendered as words for readable expectations.

#include "tk_clips.h"
#include "tk_speech.h"
#include "tk_test.h"

static const char *const NUMBERS[20] = {"zero", "one", "two", "three", "four", "five", "six",
                                        "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
                                        "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"};
static const char *const TENS[8] = {"twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"};

static void clip_name(uint16_t c, char *out, size_t cap) {
    if (c >= TK_CLIP_ZERO && c < TK_CLIP_ZERO + 20) {
        snprintf(out, cap, "%s", NUMBERS[c - TK_CLIP_ZERO]);
    } else if (c >= TK_CLIP_TWENTY && c < TK_CLIP_TWENTY + 8) {
        snprintf(out, cap, "%s", TENS[c - TK_CLIP_TWENTY]);
    } else if (c == TK_CLIP_HUNDRED) {
        snprintf(out, cap, "hundred");
    } else if (c == TK_CLIP_THOUSAND) {
        snprintf(out, cap, "thousand");
    } else if (c == TK_CLIP_MILLION) {
        snprintf(out, cap, "million");
    } else if (c == TK_CLIP_BILLION) {
        snprintf(out, cap, "billion");
    } else if (c == TK_CLIP_TRILLION) {
        snprintf(out, cap, "trillion");
    } else if (c == TK_CLIP_POINT) {
        snprintf(out, cap, "point");
    } else if (c >= TK_CLIP_LETTER_A && c < TK_CLIP_LETTER_A + 26) {
        snprintf(out, cap, "%c", 'A' + (c - TK_CLIP_LETTER_A));
    } else if (c == TK_CLIP_SPACE) {
        snprintf(out, cap, "space");
    } else if (c == TK_CLIP_HYPHEN) {
        snprintf(out, cap, "hyphen");
    } else if (c == TK_CLIP_APOSTROPHE) {
        snprintf(out, cap, "apostrophe");
    } else {
        snprintf(out, cap, "?%u", (unsigned)c);
    }
}

static void render(const uint16_t *clips, size_t n, char *out, size_t cap) {
    out[0] = '\0';
    size_t len = 0;
    for (size_t i = 0; i < n; i++) {
        char w[16];
        clip_name(clips[i], w, sizeof(w));
        len += (size_t)snprintf(out + len, cap - len, "%s%s", i ? " " : "", w);
    }
}

static void check_amount(tk_tx_kind_t kind, uint64_t amount, const char *want) {
    uint16_t clips[TK_SPEECH_AMOUNT_MAX];
    const size_t n = tk_speech_amount(kind, amount, clips, TK_SPEECH_AMOUNT_MAX);
    char got[512];
    render(clips, n, got, sizeof(got));
    if (n == 0 || strcmp(got, want) != 0) {
        fprintf(stderr, "amount %llu (%s): got \"%s\", want \"%s\"\n", (unsigned long long)amount,
                kind == TK_TX_SOL ? "SOL" : "USDC", got, want);
    }
    TK_CHECK(n > 0 && strcmp(got, want) == 0);
}

#define U(x) UINT64_C(x)

static void test_usdc(void) {
    check_amount(TK_TX_USDC, 0, "zero");
    check_amount(TK_TX_USDC, 1, "zero point zero zero zero zero zero one");
    check_amount(TK_TX_USDC, U(2500000), "two point five");
    check_amount(TK_TX_USDC, U(12500000), "twelve point five");
    check_amount(TK_TX_USDC, U(1000000), "one");
    check_amount(TK_TX_USDC, U(9000000), "nine");
    check_amount(TK_TX_USDC, U(10000000), "ten");
    check_amount(TK_TX_USDC, U(13000000), "thirteen");
    check_amount(TK_TX_USDC, U(19000000), "nineteen");
    check_amount(TK_TX_USDC, U(20000000), "twenty");
    check_amount(TK_TX_USDC, U(21000000), "twenty one");
    check_amount(TK_TX_USDC, U(99000000), "ninety nine");
    check_amount(TK_TX_USDC, U(100000000), "one hundred");
    check_amount(TK_TX_USDC, U(101000000), "one hundred one");
    check_amount(TK_TX_USDC, U(115000000), "one hundred fifteen");
    check_amount(TK_TX_USDC, U(1000000000), "one thousand");
    check_amount(TK_TX_USDC, U(1001000000), "one thousand one");
    check_amount(TK_TX_USDC, U(1205000000), "one thousand two hundred five");
    check_amount(TK_TX_USDC, U(1000000000000), "one million");
    check_amount(TK_TX_USDC, U(1000000000000000), "one billion");
    check_amount(TK_TX_USDC, U(1000000000000000000), "one trillion");
    check_amount(TK_TX_USDC, U(1234567), "one point two three four five six seven");
    check_amount(TK_TX_USDC, U(1000100), "one point zero zero zero one");
    // u64 max = 18446744073709551615 units = 18,446,744,073,709.551615 USDC
    check_amount(TK_TX_USDC, UINT64_MAX,
                 "eighteen trillion four hundred forty six billion seven hundred forty four million "
                 "seventy three thousand seven hundred nine point five five one six one five");
}

static void test_sol(void) {
    check_amount(TK_TX_SOL, 0, "zero");
    check_amount(TK_TX_SOL, 1, "zero point zero zero zero zero zero zero zero zero one");
    check_amount(TK_TX_SOL, U(1500000), "zero point zero zero one five");
    check_amount(TK_TX_SOL, U(1000000000), "one");
    check_amount(TK_TX_SOL, U(2500000000), "two point five");
    check_amount(TK_TX_SOL, U(1000000000000000), "one million");
    // u64 max lamports = 18,446,744,073.709551615 SOL
    check_amount(TK_TX_SOL, UINT64_MAX,
                 "eighteen billion four hundred forty six million seven hundred forty four thousand "
                 "seventy three point seven zero nine five five one six one five");
}

static void test_amount_errors(void) {
    uint16_t clips[TK_SPEECH_AMOUNT_MAX];
    TK_CHECK(tk_speech_amount((tk_tx_kind_t)0, 1, clips, TK_SPEECH_AMOUNT_MAX) == 0);
    TK_CHECK(tk_speech_amount(TK_TX_SOL, 1, NULL, 10) == 0);
    // "two point five" needs 3 clips: a smaller buffer gets 0 and nothing past its end.
    uint16_t small[3] = {0xAAAA, 0xAAAA, 0xBBBB};
    TK_CHECK(tk_speech_amount(TK_TX_USDC, U(2500000), small, 2) == 0);
    TK_CHECK(small[2] == 0xBBBB);
    TK_CHECK(tk_speech_amount(TK_TX_USDC, U(2500000), small, 3) == 3);
}

static void check_spell(const char *name, const char *want) {
    uint16_t clips[32];
    const size_t n = tk_speech_spell(name, strlen(name), clips, 32);
    char got[256];
    render(clips, n, got, sizeof(got));
    if (n == 0 || strcmp(got, want) != 0) {
        fprintf(stderr, "spell \"%s\": got \"%s\"\n", name, got);
    }
    TK_CHECK(n > 0 && strcmp(got, want) == 0);
}

static void test_spell(void) {
    check_spell("Alice", "A L I C E");
    check_spell("O'Neil", "O apostrophe N E I L");
    check_spell("Mary-Jane", "M A R Y hyphen J A N E");
    check_spell("Bob 2", "B O B space two");
    uint16_t clips[4];
    TK_CHECK(tk_speech_spell("A_B", 3, clips, 4) == 0);
    TK_CHECK(tk_speech_spell("Alice", 5, clips, 4) == 0); // too small
    TK_CHECK(tk_speech_spell(NULL, 1, clips, 4) == 0);
}

int main(void) {
    test_usdc();
    test_sol();
    test_amount_errors();
    test_spell();
    return tk_test_result();
}
