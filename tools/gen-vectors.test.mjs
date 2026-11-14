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
            assert.ok(e.kind === 'sol' || e.kind === 'usdc');
            assert.match(e.amount, /^\d+$/);
            assert.match(e.destination, /^[0-9a-f]{64}$/);
        } else {
            assert.equal(e.status, 'PARSE_UNSUPPORTED');
            assert.deepEqual([e.kind, e.amount, e.destination], [null, null, null]);
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

test('ATA vectors: 6 distinct wallets, valid bumps', () => {
    const ata = buildAtaVectors();
    assert.equal(ata.length, 6);
    assert.equal(new Set(ata.map((a) => a.ata)).size, 6);
    for (const a of ata) {
        assert.ok(Number.isInteger(a.bump) && a.bump >= 0 && a.bump <= 255);
    }
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
