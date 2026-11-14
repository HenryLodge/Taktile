// node --test tools/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSTANTS, base58Decode, generate } from './gen-consts.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('all-ones decodes to 32 zero bytes', () => {
    assert.equal(hex(base58Decode('1'.repeat(32))), '00'.repeat(32));
});

test('known values', () => {
    assert.equal(hex(base58Decode('2', 1)), '01');
    assert.equal(hex(base58Decode('z', 1)), '39');
    assert.equal(hex(base58Decode('21', 1)), '3a'); // 1*58 + 0
    assert.equal(hex(base58Decode('5Q', 1)), 'ff'); // 4*58 + 23
    assert.equal(hex(base58Decode('5R', 2)), '0100'); // 4*58 + 24 = 256
    assert.equal(hex(base58Decode('LUw', 3)), '010000'); // 19*58^2 + 27*58 + 54 = 65536
    assert.equal(hex(base58Decode('115R', 4)), '00000100'); // leading 1s are zero bytes
});

test('invalid characters throw', () => {
    for (const bad of ['0', 'O', 'I', 'l', ' ', '+']) {
        const s = bad + '1'.repeat(31);
        assert.throws(() => base58Decode(s), /invalid character/);
    }
    assert.throws(() => base58Decode(''), /empty/);
});

test('wrong length throws', () => {
    assert.throws(() => base58Decode('1'.repeat(31)), /expected 32/);
    assert.throws(() => base58Decode('1'.repeat(33)), /expected 32/);
    assert.throws(() => base58Decode('z'.repeat(44)), /expected 32/); // 33 bytes
});

test('every pinned constant decodes to 32 distinct bytes', () => {
    const seen = new Set();
    for (const c of CONSTANTS) {
        const h = hex(base58Decode(c.base58));
        assert.equal(h.length, 64);
        assert.ok(!seen.has(h), `${c.name} duplicates another constant`);
        seen.add(h);
    }
});

test('output is deterministic and LF-only', () => {
    const a = generate();
    const b = generate();
    assert.deepEqual(a, b);
    assert.ok(!a.header.includes('\r') && !a.source.includes('\r'));
});
