#include "tk_parser.h"

#include <string.h>

#include "sha2.h"

#define TK_SYSTEM_TRANSFER 2u
#define TK_SYSTEM_CREATE_WITH_SEED 3u
#define TK_TOKEN_TRANSFER_CHECKED 12u
#define TK_SOL_DATA_LEN 12u
#define TK_TOKEN_DATA_LEN 10u

// Stake Program instructions (bincode u32 discriminators) and their data lengths.
#define TK_STAKE_INITIALIZE 0u
#define TK_STAKE_DELEGATE 2u
#define TK_STAKE_DEACTIVATE 5u
#define TK_STAKE_INIT_DATA_LEN 116u // u32 + staker + withdrawer + lockup {i64, u64, custodian}
#define TK_STAKE_DISC_ONLY_LEN 4u

// CreateAccountWithSeed data: u32 3 | base[32] | u64 seed_len | seed | u64 lamports | u64 space | owner[32]
#define TK_CWS_FIXED_HEAD 44u           // u32 + base + u64 seed_len
#define TK_CWS_FIXED_TAIL 48u           // u64 lamports + u64 space + owner
#define TK_STAKE_SEED_PREFIX "tk-stake-"
#define TK_STAKE_SEED_PREFIX_LEN 9u
#define TK_STAKE_SEED_MAX_LEN 11u       // "tk-stake-15"

// Shape C has exactly three instructions; every other shape has one (SOLANA.md, D4).
#define TK_MAX_INSTRUCTIONS 3u

tk_parse_result_t tk_compact_u16_read(const uint8_t *p, size_t avail, uint16_t *value, size_t *used) {
    uint32_t v = 0;
    for (size_t i = 0; i < 3; i++) {
        if (i >= avail) {
            return TK_PARSE_TRUNCATED;
        }
        const uint8_t b = p[i];
        if (i == 2 && b > 0x03u) {
            return TK_PARSE_BAD_COMPACT_U16; // overflow past 16 bits, or a continuation bit
        }
        v |= (uint32_t)(b & 0x7Fu) << (7u * i);
        if ((b & 0x80u) == 0) {
            if (i > 0 && b == 0) {
                return TK_PARSE_BAD_COMPACT_U16; // alias: a shorter encoding exists
            }
            *value = (uint16_t)v;
            *used = i + 1;
            return TK_PARSE_OK;
        }
    }
    return TK_PARSE_BAD_COMPACT_U16; // unreachable: byte 3 is checked above
}

tk_status_t tk_parse_status(tk_parse_result_t r) {
    return r == TK_PARSE_OK ? TK_STATUS_OK : TK_STATUS_PARSE_UNSUPPORTED;
}

typedef struct {
    const uint8_t *p;
    size_t len;
    size_t pos;
} cursor_t;

static size_t remaining(const cursor_t *c) {
    return c->len - c->pos;
}

// Advance by n bytes, returning a pointer to them, or NULL if fewer than n remain.
static const uint8_t *take(cursor_t *c, size_t n) {
    if (n > remaining(c)) {
        return NULL;
    }
    const uint8_t *at = c->p + c->pos;
    c->pos += n;
    return at;
}

static tk_parse_result_t take_compact(cursor_t *c, uint16_t *value) {
    size_t used = 0;
    const tk_parse_result_t r = tk_compact_u16_read(c->p + c->pos, remaining(c), value, &used);
    if (r == TK_PARSE_OK) {
        c->pos += used;
    }
    return r;
}

static uint64_t read_u64_le(const uint8_t *p) {
    uint64_t v = 0;
    for (size_t i = 0; i < 8; i++) {
        v |= (uint64_t)p[i] << (8u * i);
    }
    return v;
}

static uint32_t read_u32_le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int key_eq(const uint8_t *a, const uint8_t *b) {
    return memcmp(a, b, TK_PUBKEY_LEN) == 0;
}

static int all_zero(const uint8_t *p, size_t n) {
    uint8_t acc = 0;
    for (size_t i = 0; i < n; i++) {
        acc |= p[i];
    }
    return acc == 0;
}

typedef struct {
    uint8_t program_index;
    uint16_t num_accounts;
    const uint8_t *accounts; // num_accounts bytes
    uint16_t data_len;
    const uint8_t *data; // data_len bytes
} instruction_t;

// The structurally valid pieces of a message. All pointers point into the caller's buffer.
typedef struct {
    uint8_t num_signatures;
    uint8_t num_readonly_signed;
    uint8_t num_readonly_unsigned;
    uint16_t num_keys;
    const uint8_t *keys; // num_keys * 32 bytes
    uint16_t num_instructions;
    instruction_t ix[TK_MAX_INSTRUCTIONS]; // the first min(num_instructions, 3)
} message_t;

static const uint8_t *key_at(const message_t *m, size_t i) {
    return m->keys + i * TK_PUBKEY_LEN;
}

// The key an instruction names at account position i. Callers check num_accounts first, and
// check_common has checked every index against num_keys.
static const uint8_t *acct(const message_t *m, const instruction_t *ix, size_t i) {
    return key_at(m, ix->accounts[i]);
}

static tk_parse_result_t parse_structure(const uint8_t *msg, size_t len, message_t *m) {
    cursor_t c = {msg, len, 0};
    tk_parse_result_t r;

    const uint8_t *hdr = take(&c, 3);
    if (hdr == NULL) {
        return TK_PARSE_TRUNCATED;
    }
    m->num_signatures = hdr[0];
    m->num_readonly_signed = hdr[1];
    m->num_readonly_unsigned = hdr[2];

    if ((r = take_compact(&c, &m->num_keys)) != TK_PARSE_OK) {
        return r;
    }
    // num_keys <= 0xFFFF, so the product cannot overflow size_t.
    if ((m->keys = take(&c, (size_t)m->num_keys * TK_PUBKEY_LEN)) == NULL) {
        return TK_PARSE_TRUNCATED;
    }
    if (take(&c, 32) == NULL) { // recent_blockhash: not inspected
        return TK_PARSE_TRUNCATED;
    }
    if ((r = take_compact(&c, &m->num_instructions)) != TK_PARSE_OK) {
        return r;
    }

    // Walk every instruction so truncation and trailing bytes are always detected; keep the first 3.
    for (uint32_t i = 0; i < m->num_instructions; i++) {
        const uint8_t *prog = take(&c, 1);
        if (prog == NULL) {
            return TK_PARSE_TRUNCATED;
        }
        uint16_t k = 0;
        if ((r = take_compact(&c, &k)) != TK_PARSE_OK) {
            return r;
        }
        const uint8_t *accounts = take(&c, k);
        if (accounts == NULL) {
            return TK_PARSE_TRUNCATED;
        }
        uint16_t l = 0;
        if ((r = take_compact(&c, &l)) != TK_PARSE_OK) {
            return r;
        }
        const uint8_t *data = take(&c, l);
        if (data == NULL) {
            return TK_PARSE_TRUNCATED;
        }
        if (i < TK_MAX_INSTRUCTIONS) {
            instruction_t *ix = &m->ix[i];
            ix->program_index = *prog;
            ix->num_accounts = k;
            ix->accounts = accounts;
            ix->data_len = l;
            ix->data = data;
        }
    }

    return remaining(&c) == 0 ? TK_PARSE_OK : TK_PARSE_TRAILING_BYTES;
}

// Shape C starts with System CreateAccountWithSeed. Only reads in-range data; the program index
// itself is range-checked later (an out-of-range one means "not Shape C" here).
static int starts_with_create_with_seed(const message_t *m) {
    if (m->num_instructions == 0) {
        return 0;
    }
    const instruction_t *ix = &m->ix[0];
    return ix->program_index < m->num_keys && key_eq(key_at(m, ix->program_index), TK_SYSTEM_PROGRAM_ID) &&
           ix->data_len >= 4 && read_u32_le(ix->data) == TK_SYSTEM_CREATE_WITH_SEED;
}

static tk_parse_result_t check_common(const message_t *m, const uint8_t *device) {
    // Implies num_keys >= 1, so key_at(m, 0) below is in bounds.
    if (m->num_signatures != 1 || m->num_readonly_signed != 0 ||
        m->num_readonly_unsigned >= m->num_keys) {
        return TK_PARSE_BAD_HEADER;
    }
    if (!key_eq(key_at(m, 0), device)) {
        return TK_PARSE_FEE_PAYER;
    }
    for (size_t i = 0; i < m->num_keys; i++) {
        for (size_t j = i + 1; j < m->num_keys; j++) {
            if (key_eq(key_at(m, i), key_at(m, j))) {
                return TK_PARSE_DUPLICATE_KEY;
            }
        }
    }
    // D4: exactly 3 instructions for Shape C, exactly 1 for every other shape.
    const uint16_t allowed = starts_with_create_with_seed(m) ? 3u : 1u;
    if (m->num_instructions != allowed) {
        return TK_PARSE_INSTRUCTION_COUNT;
    }
    for (size_t x = 0; x < m->num_instructions; x++) { // <= 3, all kept
        const instruction_t *ix = &m->ix[x];
        if (ix->program_index >= m->num_keys) {
            return TK_PARSE_INDEX_OUT_OF_RANGE;
        }
        for (size_t i = 0; i < ix->num_accounts; i++) {
            if (ix->accounts[i] >= m->num_keys) {
                return TK_PARSE_INDEX_OUT_OF_RANGE;
            }
        }
    }
    return TK_PARSE_OK;
}

// Shape A. accounts = [from, to]; data = u32 LE 2, u64 LE lamports.
static tk_parse_result_t parse_sol(const message_t *m, const uint8_t *device, tk_tx_t *out) {
    const instruction_t *ix = &m->ix[0];
    if (ix->num_accounts != 2 || ix->data_len != TK_SOL_DATA_LEN || read_u32_le(ix->data) != TK_SYSTEM_TRANSFER) {
        return TK_PARSE_SOL_LAYOUT;
    }
    if (!key_eq(acct(m, ix, 0), device)) {
        return TK_PARSE_SOL_FROM_NOT_DEVICE;
    }
    out->kind = TK_TX_SOL;
    out->amount = read_u64_le(ix->data + 4);
    memcpy(out->destination, acct(m, ix, 1), TK_PUBKEY_LEN);
    return TK_PARSE_OK;
}

// Shape B. accounts = [source, mint, destination, owner]; data = 12, u64 LE amount, u8 decimals.
static tk_parse_result_t parse_usdc(const message_t *m, const uint8_t *device,
                                    const uint8_t *device_usdc_ata, tk_tx_t *out) {
    const instruction_t *ix = &m->ix[0];
    if (ix->num_accounts != 4 || ix->data_len != TK_TOKEN_DATA_LEN || ix->data[0] != TK_TOKEN_TRANSFER_CHECKED) {
        return TK_PARSE_TOKEN_LAYOUT;
    }
    if (!key_eq(acct(m, ix, 1), TK_DEVNET_USDC_MINT)) {
        return TK_PARSE_TOKEN_WRONG_MINT;
    }
    if (ix->data[9] != TK_USDC_DECIMALS) {
        return TK_PARSE_TOKEN_WRONG_DECIMALS;
    }
    if (!key_eq(acct(m, ix, 0), device_usdc_ata)) {
        return TK_PARSE_TOKEN_WRONG_SOURCE;
    }
    if (!key_eq(acct(m, ix, 3), device)) {
        return TK_PARSE_TOKEN_OWNER_NOT_DEVICE;
    }
    out->kind = TK_TX_USDC;
    out->amount = read_u64_le(ix->data + 1);
    memcpy(out->destination, acct(m, ix, 2), TK_PUBKEY_LEN);
    return TK_PARSE_OK;
}

// ---- Staking ----

// "tk-stake-0" .. "tk-stake-15", exactly (no leading zero, no sign, no padding). Returns n or -1.
static int stake_seed_index(const uint8_t *seed, size_t len) {
    if (len <= TK_STAKE_SEED_PREFIX_LEN || len > TK_STAKE_SEED_MAX_LEN ||
        memcmp(seed, TK_STAKE_SEED_PREFIX, TK_STAKE_SEED_PREFIX_LEN) != 0) {
        return -1;
    }
    const uint8_t *d = seed + TK_STAKE_SEED_PREFIX_LEN;
    if (len == TK_STAKE_SEED_PREFIX_LEN + 1) {
        return (d[0] >= '0' && d[0] <= '9') ? d[0] - '0' : -1;
    }
    // two digits: 10-15 only
    return (d[0] == '1' && d[1] >= '0' && d[1] <= '5') ? 10 + (d[1] - '0') : -1;
}

// createWithSeed(base, seed, owner) = SHA256(base || seed || owner); not a PDA, no curve check.
static void seed_address(const uint8_t *base, const uint8_t *seed, size_t seed_len, const uint8_t *owner,
                         uint8_t out[TK_PUBKEY_LEN]) {
    SHA256_CTX ctx;
    sha256_Init(&ctx);
    sha256_Update(&ctx, base, TK_PUBKEY_LEN);
    sha256_Update(&ctx, seed, seed_len);
    sha256_Update(&ctx, owner, TK_PUBKEY_LEN);
    sha256_Final(&ctx, out);
}

// The device's own stake account tk-stake-<n>.
static void device_stake_account(const uint8_t *device, unsigned n, uint8_t out[TK_PUBKEY_LEN]) {
    uint8_t seed[TK_STAKE_SEED_MAX_LEN];
    memcpy(seed, TK_STAKE_SEED_PREFIX, TK_STAKE_SEED_PREFIX_LEN);
    size_t len = TK_STAKE_SEED_PREFIX_LEN;
    if (n >= 10) {
        seed[len++] = '1';
        seed[len++] = (uint8_t)('0' + (n - 10));
    } else {
        seed[len++] = (uint8_t)('0' + n);
    }
    seed_address(device, seed, len, TK_STAKE_PROGRAM_ID, out);
}

static int is_stake_ix(const message_t *m, const instruction_t *ix, uint16_t accounts, uint16_t data_len,
                       uint32_t disc) {
    return key_eq(key_at(m, ix->program_index), TK_STAKE_PROGRAM_ID) && ix->num_accounts == accounts &&
           ix->data_len == data_len && read_u32_le(ix->data) == disc;
}

// Shape C: CreateAccountWithSeed + Initialize + DelegateStake (SOLANA.md). The critical check is in
// step 2: staker and withdrawer are the device and the lockup is entirely empty, so the SOL can only
// ever come back to the device.
static tk_parse_result_t parse_stake(const message_t *m, const uint8_t *device, tk_tx_t *out) {
    // 1. System CreateAccountWithSeed: [funder (= base), new]
    const instruction_t *cws = &m->ix[0];
    if (cws->num_accounts != 2 || cws->data_len < TK_CWS_FIXED_HEAD) {
        return TK_PARSE_STAKE_LAYOUT;
    }
    const uint8_t *d = cws->data;
    const uint64_t seed_len = read_u64_le(d + 36);
    if (seed_len > 32 || cws->data_len != TK_CWS_FIXED_HEAD + seed_len + TK_CWS_FIXED_TAIL) {
        return TK_PARSE_STAKE_LAYOUT; // the seed length doesn't match the data (or is absurd)
    }
    const uint8_t *base = d + 4;
    const uint8_t *seed = d + TK_CWS_FIXED_HEAD;
    const uint8_t *lamports = seed + seed_len;
    const uint8_t *space = lamports + 8;
    const uint8_t *owner = space + 8;
    if (!key_eq(acct(m, cws, 0), device)) {
        return TK_PARSE_STAKE_FUNDER_NOT_DEVICE;
    }
    if (!key_eq(base, device)) {
        return TK_PARSE_STAKE_BASE_NOT_DEVICE;
    }
    const int index = stake_seed_index(seed, (size_t)seed_len);
    if (index < 0) {
        return TK_PARSE_STAKE_SEED;
    }
    if (!key_eq(owner, TK_STAKE_PROGRAM_ID)) {
        return TK_PARSE_STAKE_WRONG_OWNER;
    }
    if (read_u64_le(space) != TK_STAKE_SPACE) {
        return TK_PARSE_STAKE_WRONG_SPACE;
    }
    uint8_t stake[TK_PUBKEY_LEN];
    seed_address(device, seed, (size_t)seed_len, TK_STAKE_PROGRAM_ID, stake);
    if (!key_eq(acct(m, cws, 1), stake)) {
        return TK_PARSE_STAKE_ADDRESS_MISMATCH;
    }

    // 2. Stake Initialize: [stake, rent]; data = 0 | staker | withdrawer | lockup{ts, epoch, custodian}
    const instruction_t *init = &m->ix[1];
    if (!is_stake_ix(m, init, 2, TK_STAKE_INIT_DATA_LEN, TK_STAKE_INITIALIZE)) {
        return TK_PARSE_STAKE_LAYOUT;
    }
    if (!key_eq(acct(m, init, 0), stake)) {
        return TK_PARSE_STAKE_WRONG_ACCOUNT;
    }
    if (!key_eq(acct(m, init, 1), TK_SYSVAR_RENT_ID)) {
        return TK_PARSE_STAKE_WRONG_SYSVAR;
    }
    if (!key_eq(init->data + 4, device) || !key_eq(init->data + 36, device)) {
        return TK_PARSE_STAKE_AUTHORITY_NOT_DEVICE; // staker, withdrawer
    }
    if (!all_zero(init->data + 68, 8 + 8 + TK_PUBKEY_LEN)) {
        return TK_PARSE_STAKE_LOCKUP; // unix_timestamp, epoch, custodian
    }

    // 3. Stake DelegateStake: [stake, vote, clock, stake history, config, authority]
    const instruction_t *del = &m->ix[2];
    if (!is_stake_ix(m, del, 6, TK_STAKE_DISC_ONLY_LEN, TK_STAKE_DELEGATE)) {
        return TK_PARSE_STAKE_LAYOUT;
    }
    if (!key_eq(acct(m, del, 0), stake)) {
        return TK_PARSE_STAKE_WRONG_ACCOUNT;
    }
    if (!key_eq(acct(m, del, 2), TK_SYSVAR_CLOCK_ID) || !key_eq(acct(m, del, 3), TK_SYSVAR_STAKE_HISTORY_ID) ||
        !key_eq(acct(m, del, 4), TK_STAKE_CONFIG_ID)) {
        return TK_PARSE_STAKE_WRONG_SYSVAR;
    }
    if (!key_eq(acct(m, del, 5), device)) {
        return TK_PARSE_STAKE_AUTHORITY_NOT_DEVICE;
    }
    if (!key_eq(acct(m, del, 1), TK_VALIDATOR_VOTE)) {
        return TK_PARSE_STAKE_WRONG_VALIDATOR; // last: everything else about it is right
    }

    out->kind = TK_TX_STAKE;
    out->amount = read_u64_le(lamports);
    memcpy(out->destination, stake, TK_PUBKEY_LEN);
    out->stake_index = (uint8_t)index;
    return TK_PARSE_OK;
}

// Shape D: Stake Deactivate on one of the device's own stake accounts. [stake, clock, authority]
static tk_parse_result_t parse_unstake(const message_t *m, const uint8_t *device, tk_tx_t *out) {
    const instruction_t *ix = &m->ix[0];
    if (!is_stake_ix(m, ix, 3, TK_STAKE_DISC_ONLY_LEN, TK_STAKE_DEACTIVATE)) {
        return TK_PARSE_STAKE_LAYOUT; // includes Authorize, Withdraw, Split, SetLockup, ...
    }
    if (!key_eq(acct(m, ix, 1), TK_SYSVAR_CLOCK_ID)) {
        return TK_PARSE_STAKE_WRONG_SYSVAR;
    }
    if (!key_eq(acct(m, ix, 2), device)) {
        return TK_PARSE_STAKE_AUTHORITY_NOT_DEVICE;
    }
    for (unsigned n = 0; n < TK_STAKE_SEEDS; n++) {
        uint8_t mine[TK_PUBKEY_LEN];
        device_stake_account(device, n, mine);
        if (key_eq(acct(m, ix, 0), mine)) {
            out->kind = TK_TX_UNSTAKE;
            out->amount = 0;
            memcpy(out->destination, mine, TK_PUBKEY_LEN);
            out->stake_index = (uint8_t)n;
            return TK_PARSE_OK;
        }
    }
    return TK_PARSE_STAKE_NOT_DERIVED;
}

static tk_parse_result_t parse(const uint8_t *msg, size_t len, const uint8_t *device,
                               const uint8_t *device_usdc_ata, tk_tx_t *out) {
    if (len > TK_MAX_MESSAGE_LEN) {
        return TK_PARSE_TOO_LARGE;
    }
    if (len == 0) {
        return TK_PARSE_TRUNCATED;
    }
    if ((msg[0] & 0x80u) != 0) {
        return TK_PARSE_VERSIONED;
    }

    message_t m;
    memset(&m, 0, sizeof(m));
    tk_parse_result_t r = parse_structure(msg, len, &m);
    if (r != TK_PARSE_OK) {
        return r;
    }
    if ((r = check_common(&m, device)) != TK_PARSE_OK) {
        return r;
    }

    // Dispatch on the first instruction (SOLANA.md "Order of checks").
    const uint8_t *program = key_at(&m, m.ix[0].program_index);
    if (key_eq(program, TK_SYSTEM_PROGRAM_ID)) {
        return starts_with_create_with_seed(&m) ? parse_stake(&m, device, out) : parse_sol(&m, device, out);
    }
    if (key_eq(program, TK_TOKEN_PROGRAM_ID)) {
        return parse_usdc(&m, device, device_usdc_ata, out);
    }
    if (key_eq(program, TK_STAKE_PROGRAM_ID)) {
        return parse_unstake(&m, device, out);
    }
    return TK_PARSE_UNSUPPORTED_PROGRAM;
}

tk_parse_result_t tk_parse_message(const uint8_t *msg, size_t len,
                                   const uint8_t device_pubkey[TK_PUBKEY_LEN],
                                   const uint8_t device_usdc_ata[TK_PUBKEY_LEN], tk_tx_t *out) {
    memset(out, 0, sizeof(*out));
    if ((msg == NULL && len > 0) || device_pubkey == NULL || device_usdc_ata == NULL) {
        return TK_PARSE_TRUNCATED;
    }
    const tk_parse_result_t r = parse(msg, len, device_pubkey, device_usdc_ata, out);
    if (r != TK_PARSE_OK) {
        memset(out, 0, sizeof(*out));
    }
    return r;
}
