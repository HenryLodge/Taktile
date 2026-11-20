// node --test tools/*.test.mjs   (needs `cd tools && npm ci`)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildAtaVectors,
    buildParserVectors,
    encodeCompactU16,
    generate,
    readCompactU16,
    walkLegacy,
} from './gen-vectors.mjs';

const vectors = buildParserVectors();
const byName = Object.fromEntries(vectors.map((v) => [v.name, v]));

test('compact-u16 encodes and decodes', () => {
    for (const [value, hex] of [[0, '00'], [0x7f, '7f'], [0x80, '8001'], [0x3fff, 'ff7f'], [0x4000, '808001'], [0xffff, 'ffff03']]) {
        assert.equal(encodeCompactU16(value).toString('hex'), hex);
        assert.deepEqual(readCompactU16(Buffer.from(hex, 'hex'), 0), { value, size: hex.length / 2 });
    }
    assert.throws(() => encodeCompactU16(0x10000));
    assert.throws(() => readCompactU16(Buffer.from('808080', 'hex'), 0), /longer than 3/);
    assert.throws(() => readCompactU16(Buffer.from('80', 'hex'), 0), /past the buffer/);
});

test('walker offsets on the SOL transfer', () => {
    const bytes = Buffer.from(byName.sol_ok.message_hex, 'hex');
    const lay = walkLegacy(bytes);
    const at = (name) => lay.fields.find((f) => f.name === name);
    assert.deepEqual(at('num_account_keys'), { name: 'num_account_keys', start: 3, end: 4 });
    assert.deepEqual(at('recent_blockhash'), { name: 'recent_blockhash', start: 100, end: 132 });
    assert.deepEqual(at('data'), { name: 'data', start: 138, end: 150 });
    assert.equal(lay.fields.at(-1).end, bytes.length);
    // Fields tile the message with no gaps.
    for (let i = 1; i < lay.fields.length; i++) {
        assert.equal(lay.fields[i].start, lay.fields[i - 1].end);
    }
    assert.equal(lay.data.readUInt32LE(0), 2); // System Transfer
});

test('output is deterministic and LF-only', () => {
    const a = generate();
    const b = generate();
    assert.deepEqual(a, b);
    for (const [, text] of a) {
        assert.ok(!text.includes('\r'));
    }
});

test('names are unique and sorted', () => {
    const names = vectors.map((v) => v.name);
    assert.deepEqual(names, [...new Set(names)].sort());
});

test('every SOLANA.md negative category is covered', () => {
    const required = [
        'msg_v0', 'common_two_instructions', 'common_wrong_fee_payer', 'common_two_signers',
        'usdc_plain_transfer', 'usdc_wrong_mint', 'usdc_decimals_9',
        'usdc_source_not_device_ata', 'usdc_owner_not_device',
        'msg_noncanonical_compact_u16_keys', 'msg_trailing_byte_sol', 'usdc_token_2022_program',
        'msg_oversized', 'msg_compact_u16_over_ffff',
    ];
    for (const name of required) {
        assert.ok(byName[name], `missing ${name}`);
        assert.equal(byName[name].expect.status, 'PARSE_UNSUPPORTED');
    }
    assert.ok(vectors.filter((v) => v.name.startsWith('msg_truncated_sol_')).length >= 10);
    assert.ok(vectors.filter((v) => v.name.startsWith('msg_truncated_usdc_')).length >= 10);
});

test('OK vectors carry kind, amount and destination; rejections carry none', () => {
    for (const v of vectors) {
        const e = v.expect;
        if (e.status === 'OK') {
            assert.ok(['sol', 'usdc', 'stake', 'unstake'].includes(e.kind));
            assert.match(e.amount, /^\d+$/);
            assert.match(e.destination, /^[0-9a-f]{64}$/);
            const staking = e.kind === 'stake' || e.kind === 'unstake';
            assert.ok(staking ? Number.isInteger(e.stake_index) && e.stake_index >= 0 && e.stake_index <= 15 : e.stake_index === null);
        } else {
            assert.equal(e.status, 'PARSE_UNSUPPORTED');
            assert.deepEqual([e.kind, e.amount, e.destination, e.stake_index], [null, null, null, null]);
        }
    }
    assert.equal(byName.sol_ok_u64_max.expect.amount, '18446744073709551615');
});

test('truncations are strict prefixes of their base message', () => {
    for (const [prefix, base] of [['msg_truncated_sol_', 'sol_ok'], ['msg_truncated_usdc_', 'usdc_ok']]) {
        const full = byName[base].message_hex;
        for (const v of vectors.filter((x) => x.name.startsWith(prefix))) {
            assert.ok(v.message_hex.length < full.length && full.startsWith(v.message_hex), v.name);
        }
    }
});

test('ATA vectors: distinct, two mints, at least two deep bump searches', () => {
    const ata = buildAtaVectors();
    assert.ok(ata.length >= 10);
    assert.equal(new Set(ata.map((a) => a.ata)).size, ata.length);
    assert.equal(new Set(ata.map((a) => a.name)).size, ata.length);
    assert.equal(new Set(ata.map((a) => a.mint)).size, 2);
    assert.ok(ata.filter((a) => a.bump <= 251).length >= 2);
    for (const a of ata) {
        assert.ok(Number.isInteger(a.bump) && a.bump >= 0 && a.bump <= 255);
    }
});

test('curve vectors: both answers occur', async () => {
    const { buildCurveVectors } = await import('./gen-vectors.mjs');
    const curve = buildCurveVectors();
    assert.equal(curve.length, 32);
    assert.ok(curve.some((c) => c.on_curve));
    assert.ok(curve.some((c) => !c.on_curve));
});

test('PARSE_REASONS matches tk_parse_result_t in tk_parser.h, in order', async () => {
    const { readFileSync } = await import('node:fs');
    const { PARSE_REASONS } = await import('./gen-vectors.mjs');
    const h = readFileSync(new URL('../core/include/tk_parser.h', import.meta.url), 'utf8');
    const body = h.slice(h.indexOf('typedef enum {\n    TK_PARSE_OK'.replace(/\n/g, h.includes('\r\n') ? '\r\n' : '\n')));
    const names = [...body.slice(0, body.indexOf('} tk_parse_result_t;')).matchAll(/\bTK_PARSE_([A-Z0-9_]+)/g)].map((m) => m[1]);
    assert.deepEqual(names, PARSE_REASONS);
});

test('every vector has a known reason, and every rejection reason is exercised', async () => {
    const { PARSE_REASONS } = await import('./gen-vectors.mjs');
    for (const v of vectors) {
        assert.ok(PARSE_REASONS.includes(v.expect.reason), `${v.name}: ${v.expect.reason}`);
        assert.equal(v.expect.reason === 'OK', v.expect.status === 'OK', v.name);
        assert.match(v.device_usdc_ata, /^[0-9a-f]{64}$/);
    }
    const used = new Set(vectors.map((v) => v.expect.reason));
    for (const r of PARSE_REASONS) {
        assert.ok(used.has(r), `no vector for ${r}`);
    }
});

test('checksum vectors: every OK transfer plus edge cases, words match indices', async () => {
    const { buildChecksumVectors } = await import('./gen-vectors.mjs');
    const { loadWords } = await import('./gen-words.mjs');
    const words = loadWords();
    const { tx, addr } = buildChecksumVectors();
    const okCount = vectors.filter((v) => v.expect.status === 'OK').length;
    assert.equal(tx.length, okCount + 4);
    assert.ok(addr.length >= 6);
    for (const v of [...tx, ...addr]) {
        assert.deepEqual(v.words, v.indices.map((i) => words[i]), v.name);
    }
    assert.deepEqual(tx.find((v) => v.name === 'empty').indices, [0x47, 0x24, 0x5a]); // sha256sum
    const a = tx.find((v) => v.name === 'sol_ok');
    const b = tx.find((v) => v.name === 'sol_ok_amount_bit_flipped');
    assert.notDeepEqual(a.indices, b.indices);
});

test('contacts vectors: book of 3, every contact found by both kinds, malicious cases unknown', async () => {
    const { buildContactsVectors } = await import('./gen-vectors.mjs');
    const { book, lookups } = buildContactsVectors();
    assert.equal(book.length, 3);
    for (let i = 0; i < book.length; i++) {
        assert.ok(lookups.some((l) => l.kind === 'sol' && l.expect_index === i && l.destination === book[i].wallet));
        assert.ok(lookups.some((l) => l.kind === 'usdc' && l.expect_index === i && l.destination === book[i].usdc_ata));
    }
    for (const name of [
        'alice_ata_as_sol', 'alice_wallet_as_usdc', 'mallory_wallet_sol', 'mallory_ata_usdc',
        'alice_ata_one_bit_flipped', 'alice_other_mint_ata_usdc', 'device_wallet_sol',
    ]) {
        const l = lookups.find((x) => x.name === name);
        assert.ok(l, `missing ${name}`);
        assert.equal(l.expect_index, -1, name);
    }
});

test('stake account addresses: seedAddress (SHA256(base || seed || owner)) equals web3.js createWithSeed', async () => {
    const { PublicKey, StakeProgram } = await import('@solana/web3.js');
    const { seedAddress, stakeSeed, wallet } = await import('./gen-vectors.mjs');
    const device = wallet('device');
    for (let n = 0; n < 16; n++) {
        const theirs = await PublicKey.createWithSeed(device, stakeSeed(n), StakeProgram.programId);
        assert.ok(seedAddress(device, stakeSeed(n)).equals(theirs), `tk-stake-${n}`);
    }
});

test('stake vectors: the critical checks and every staking reason are covered', () => {
    const must = {
        stake_init_withdrawer_not_device: 'STAKE_AUTHORITY_NOT_DEVICE',
        stake_init_staker_not_device: 'STAKE_AUTHORITY_NOT_DEVICE',
        stake_init_lockup_custodian: 'STAKE_LOCKUP',
        stake_init_lockup_epoch: 'STAKE_LOCKUP',
        stake_init_lockup_timestamp: 'STAKE_LOCKUP',
        stake_delegate_other_validator: 'STAKE_WRONG_VALIDATOR',
        stake_create_address_random: 'STAKE_ADDRESS_MISMATCH',
        stake_seed_16: 'STAKE_SEED',
        stake_authorize_withdrawer_alone: 'STAKE_LAYOUT',
        stake_withdraw_alone: 'STAKE_LAYOUT',
        unstake_not_derived_random: 'STAKE_NOT_DERIVED',
        stake_count_four_instructions: 'INSTRUCTION_COUNT',
    };
    for (const [name, reason] of Object.entries(must)) {
        assert.equal(byName[name]?.expect.reason, reason, name);
    }
    for (const name of ['stake_ok_seed0', 'stake_ok_seed15', 'unstake_ok_seed0', 'unstake_ok_seed15']) {
        assert.equal(byName[name]?.expect.status, 'OK', name);
    }
    assert.equal(byName.stake_ok_seed0.expect.amount, '1001666240'); // 1 SOL + the rent-exempt reserve
    assert.ok(vectors.filter((v) => v.name.startsWith('msg_truncated_stake_')).length >= 30);
});
