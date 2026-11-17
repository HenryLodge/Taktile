import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { clipsFingerprint, crc32 } from './gen-clips.mjs';
import { HEADER_LEN, buildPack } from './pack-clips.mjs';

const CLIPS = [
    { id: 0, name: 'A', text: 'alpha' },
    { id: 1, name: 'B', text: 'bravo' },
    { id: 2, name: 'C', text: 'charlie' },
];
const PCM = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0, 5, 0]), Buffer.from([6, 0])];

test('crc32 matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('pack layout: header, index, aligned data, CRC', () => {
    const p = buildPack(CLIPS, (c) => PCM[c.id]);
    assert.equal(p.toString('ascii', 0, 4), 'TKCP');
    assert.equal(p.readUInt16LE(4), 1);
    assert.equal(p.readUInt16LE(6), 3);
    assert.equal(p.readUInt32LE(8), p.length);
    assert.equal(p.readUInt32LE(12), clipsFingerprint(CLIPS));
    const dataStart = HEADER_LEN + 8 * 3;
    assert.equal(p.readUInt32LE(16), crc32(p.subarray(dataStart)));
    for (let i = 0; i < 3; i++) {
        const off = p.readUInt32LE(HEADER_LEN + 8 * i);
        const len = p.readUInt32LE(HEADER_LEN + 8 * i + 4);
        assert.equal(off % 4, 0);
        assert.ok(off >= dataStart && off + len <= p.length);
        assert.deepEqual(p.subarray(off, off + len), PCM[i]);
    }
});

test('fingerprint changes when any text changes', () => {
    const other = CLIPS.map((c) => (c.id === 1 ? { ...c, text: 'bravo2' } : c));
    assert.notEqual(clipsFingerprint(other), clipsFingerprint(CLIPS));
});

test('rejects odd-length, empty or out-of-order clips', () => {
    assert.throws(() => buildPack(CLIPS, (c) => (c.id === 1 ? Buffer.from([1, 2, 3]) : PCM[c.id])), /even/);
    assert.throws(() => buildPack(CLIPS, (c) => (c.id === 2 ? Buffer.alloc(0) : PCM[c.id])), /even, non-zero/);
    assert.throws(() => buildPack([CLIPS[1], CLIPS[0]], (c) => PCM[c.id]), /has id/);
});

test('fingerprint in core/include/tk_clips_fp.h matches tools/clips.json', () => {
    const clips = JSON.parse(readFileSync(new URL('./clips.json', import.meta.url), 'utf8'));
    const h = readFileSync(new URL('../core/include/tk_clips_fp.h', import.meta.url), 'utf8');
    const m = h.match(/TK_CLIPS_FINGERPRINT 0x([0-9a-f]{8})u/);
    assert.ok(m);
    assert.equal(parseInt(m[1], 16), clipsFingerprint(clips));
});
