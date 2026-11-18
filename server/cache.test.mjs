import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createCache } from './lib/cache.mjs';
import { makeRedactor } from './lib/http.mjs';
import { toneWav } from './lib/tone.mjs';

test('cache: miss, put, hit; keys depend on every part; no temp files left', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tk-cache-')), 'nested');
    try {
        const c = createCache(dir);
        const k = c.key({ text: 'Sent.', voice: 'v', model: 'm' });
        assert.match(k, /^[0-9a-f]{64}$/);
        assert.notEqual(k, c.key({ text: 'Sent.', voice: 'v2', model: 'm' }));
        assert.equal(await c.get(k), null);
        await c.put(k, Buffer.from('abc'));
        assert.equal((await c.get(k)).toString(), 'abc');
        assert.deepEqual(readdirSync(dir), [`${k}.mp3`]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('redactor', () => {
    const r = makeRedactor('sk_abcdef');
    assert.equal(r('x sk_abcdef y sk_abcdef'), 'x [redacted] y [redacted]');
    assert.equal(makeRedactor('')('anything'), 'anything');
});

test('tone wav header', () => {
    const w = toneWav();
    assert.equal(w.toString('ascii', 0, 4), 'RIFF');
    assert.equal(w.readUInt32LE(24), 16000);
    assert.equal(w.length, 44 + 4800 * 2);
    assert.equal(w.readInt16LE(44), 0); // fades in
});
