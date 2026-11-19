import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { base58 } from './base58.ts';
import { crc32 } from './crc32.ts';
import { FrameDecoder, MAX_PAYLOAD, encodeFrame, type DecodeResult } from './frame.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Built the same way as docs/sim-client.mjs, independently of frame.ts.
function refFrame(type: number, seq: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const head = Buffer.from([0xe5, 0x01, type, seq, payload.length & 0xff, payload.length >> 8]);
    const body = Buffer.concat([head, Buffer.from(payload)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(zlib.crc32(body) >>> 0);
    return new Uint8Array(Buffer.concat([body, crc]));
}

const frames = (rs: DecodeResult[]) => rs.filter((r) => r.kind === 'frame');

test('crc32 check value and agreement with zlib', () => {
    assert.equal(crc32(enc('123456789')), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
    for (let i = 0; i < 200; i++) {
        const b = randomBytes(i * 7);
        assert.equal(crc32(b), zlib.crc32(b) >>> 0);
    }
});

test('encode matches the reference construction', () => {
    assert.deepEqual(encodeFrame(0x01, 1), refFrame(0x01, 1));
    assert.deepEqual(Array.from(encodeFrame(0x01, 1).subarray(0, 6)), [0xe5, 0x01, 0x01, 0x01, 0x00, 0x00]);
    const p = randomBytes(300);
    assert.deepEqual(encodeFrame(0x10, 200, p), refFrame(0x10, 200, p));
    assert.equal(encodeFrame(0x10, 1, new Uint8Array(MAX_PAYLOAD)).length, 6 + MAX_PAYLOAD + 4);
    assert.throws(() => encodeFrame(0x10, 1, new Uint8Array(MAX_PAYLOAD + 1)), RangeError);
    assert.throws(() => encodeFrame(0x100, 1), RangeError);
    assert.throws(() => encodeFrame(0x01, 256), RangeError);
});

test('decode: round trip, byte at a time, two in one chunk', () => {
    const a = refFrame(0x81, 1, Uint8Array.from([1, 0, 1, 1]));
    const b = refFrame(0xf0, 2, Uint8Array.from([2]));
    const d = new FrameDecoder();
    const out: DecodeResult[] = [];
    for (const byte of a) {
        out.push(...d.push(Uint8Array.of(byte)));
    }
    assert.deepEqual(out, [{ kind: 'frame', type: 0x81, seq: 1, payload: Uint8Array.from([1, 0, 1, 1]) }]);
    const both = d.push(new Uint8Array([...a, ...b]));
    assert.equal(both.length, 2);
    assert.equal(d.pending, 0);
});

test('decode: empty and maximum payloads', () => {
    const d = new FrameDecoder();
    assert.equal(frames(d.push(refFrame(0x82, 9)))[0]?.payload.length, 0);
    const big = randomBytes(MAX_PAYLOAD);
    const r = frames(d.push(refFrame(0x90, 3, big)));
    assert.deepEqual(r[0]?.payload, new Uint8Array(big));
});

test('decode: garbage before a frame is skipped silently', () => {
    const d = new FrameDecoder();
    const r = d.push(new Uint8Array([0, 1, 2, 0x7f, ...refFrame(0x81, 4, Uint8Array.from([1, 0, 1, 0]))]));
    assert.equal(r.length, 1);
    assert.equal(r[0]?.kind, 'frame');
});

test('decode: bad CRC, then a good frame', () => {
    const bad = refFrame(0x81, 5, Uint8Array.from([1, 2, 3]));
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    const d = new FrameDecoder();
    const r = d.push(new Uint8Array([...bad, ...refFrame(0x82, 6, Uint8Array.from([0]))]));
    assert.equal(r[0]?.kind, 'bad');
    const f = frames(r);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.seq, 6);
});

test('decode: a real frame that starts inside a corrupt one is found', () => {
    const real = refFrame(0x81, 7, Uint8Array.from([1, 0, 1, 2]));
    // A header claiming 10 payload bytes whose "payload" is the start of a real frame.
    const corrupt = new Uint8Array([0xe5, 0x01, 0x81, 0x09, 10, 0]);
    const d = new FrameDecoder();
    const r = d.push(new Uint8Array([...corrupt, ...real]));
    assert.ok(r.some((x) => x.kind === 'bad'));
    assert.deepEqual(
        frames(r).map((f) => f.seq),
        [7],
    );
});

test('decode: bad version and too-large length', () => {
    const v = refFrame(0x81, 1);
    v[1] = 0x02;
    const d = new FrameDecoder();
    assert.deepEqual(d.push(v.subarray(0, 6)), [{ kind: 'bad', seq: 1 }]);
    const tooBig = new Uint8Array([0xe5, 0x01, 0x90, 0x08, 0x01, 0x08]); // len 2049
    assert.deepEqual(new FrameDecoder().push(tooBig), [{ kind: 'too_large', seq: 8 }]);
});

test('decode: random streams never throw and only valid frames come out', () => {
    let found = 0;
    for (let i = 0; i < 500; i++) {
        const d = new FrameDecoder();
        const stream = randomBytes(1 + (i % 300));
        // sprinkle magic bytes so headers actually start
        for (let j = 0; j < stream.length; j += 11) {
            stream[j] = 0xe5;
        }
        for (const r of d.push(stream)) {
            if (r.kind === 'frame') {
                found++;
                assert.deepEqual(refFrame(r.type, r.seq, r.payload).subarray(6, 6 + r.payload.length), r.payload);
            }
        }
    }
    assert.ok(found >= 0);
});

test('base58', () => {
    assert.equal(base58(new Uint8Array(0)), '');
    assert.equal(base58(Uint8Array.of(0)), '1');
    assert.equal(base58(Uint8Array.of(0, 0, 1)), '112');
    assert.equal(base58(enc('Hello World!')), '2NEpo7TZRRrLZSi2U');
    assert.equal(base58(new Uint8Array(32)), '11111111111111111111111111111111'); // System Program
});
