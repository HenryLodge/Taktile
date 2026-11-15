import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizePeak, parseWav, peakTarget, SAMPLE_RATE, trimSilence, writeWav } from './audio.mjs';
import { cacheKey, DEFAULT_SETTINGS, parseEnv, run, selectClips } from './gen-audio.mjs';

const ms = (n) => Math.round((SAMPLE_RATE * n) / 1000);

// silence, a tone, silence
function toneClip(leadMs = 200, toneMs = 300, tailMs = 250, amp = 8000) {
    const s = new Int16Array(ms(leadMs) + ms(toneMs) + ms(tailMs));
    for (let i = 0; i < ms(toneMs); i++) s[ms(leadMs) + i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
    // the tone's first and last samples are near zero; force clear edges for exact checks
    s[ms(leadMs)] = amp;
    s[ms(leadMs) + ms(toneMs) - 1] = -amp;
    return s;
}

test('WAV round trip and strict format checks', () => {
    const s = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    assert.deepEqual(parseWav(writeWav(s)), s);
    const bad = (patch) => {
        const b = writeWav(s);
        patch(b);
        return b;
    };
    assert.throws(() => parseWav(bad((b) => b.writeUInt16LE(8, 34))), /16-bit mono/); // 8-bit
    assert.throws(() => parseWav(bad((b) => b.writeUInt16LE(2, 22))), /16-bit mono/); // stereo
    assert.throws(() => parseWav(bad((b) => b.writeUInt32LE(44100, 24))), /16-bit mono/); // 44.1 kHz
    assert.throws(() => parseWav(bad((b) => b.writeUInt16LE(3, 20))), /16-bit mono/); // float
    assert.throws(() => parseWav(Buffer.from('not a wav at all')), /not a WAV/);
    // A streaming-style data size of 0xFFFFFFFF means "to the end".
    assert.deepEqual(parseWav(bad((b) => b.writeUInt32LE(0xffffffff, 40))), s);
});

test('trimSilence keeps exactly 40 ms each side', () => {
    const out = trimSilence(toneClip());
    assert.equal(out.length, ms(40) + ms(300) + ms(40));
    // Short margins: less than 40 ms of silence available is kept as-is.
    const tight = trimSilence(toneClip(10, 300, 5));
    assert.equal(tight.length, ms(10) + ms(300) + ms(5));
    assert.throws(() => trimSilence(new Int16Array(1000)), /silent/);
    // Quiet noise below -45 dBFS counts as silence.
    const noisy = toneClip();
    for (let i = 0; i < ms(150); i++) noisy[i] = i % 2 ? 150 : -150;
    assert.equal(trimSilence(noisy).length, ms(40) + ms(300) + ms(40));
});

test('normalizePeak lands on -3 dBFS and never clips', () => {
    for (const amp of [100, 8000, 32767]) {
        const out = normalizePeak(toneClip(0, 100, 0, amp));
        let peak = 0;
        for (const v of out) peak = Math.max(peak, Math.abs(v));
        assert.equal(peak, peakTarget());
    }
    assert.equal(peakTarget(), 23197);
    assert.throws(() => normalizePeak(new Int16Array(10)), /silent/);
});

test('parseEnv: quotes, comments, CRLF, export', () => {
    const env = parseEnv('# comment\r\nA=1\r\nB="two words"\r\nexport C=\'x\'\r\nD=val # trailing\r\nE=\r\nbad line\r\n');
    assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: 'val', E: '' });
});

test('cacheKey changes with text, say, voice and every setting', () => {
    const c = { id: 1, name: 'X', text: 'send' };
    const base = cacheKey(c, 'voice', DEFAULT_SETTINGS);
    assert.equal(base, cacheKey({ ...c, id: 2, name: 'Y' }, 'voice', DEFAULT_SETTINGS)); // id/name don't matter
    assert.notEqual(base, cacheKey({ ...c, text: 'sent' }, 'voice', DEFAULT_SETTINGS));
    assert.notEqual(base, cacheKey({ ...c, say: 'sennd' }, 'voice', DEFAULT_SETTINGS));
    assert.notEqual(base, cacheKey(c, 'voice2', DEFAULT_SETTINGS));
    assert.notEqual(base, cacheKey(c, 'voice', { ...DEFAULT_SETTINGS, seed: 2 }));
    assert.notEqual(base, cacheKey(c, 'voice', { ...DEFAULT_SETTINGS, model_id: 'other' }));
    assert.notEqual(base, cacheKey(c, 'voice', {
        ...DEFAULT_SETTINGS, voice_settings: { ...DEFAULT_SETTINGS.voice_settings, speed: 1 },
    }));
});

test('selectClips by id, name or text', () => {
    const clips = [{ id: 0, name: 'A0', text: 'aardvark' }, { id: 1, name: 'B', text: 'send' }, { id: 2, name: 'C', text: 'A' }];
    assert.deepEqual(selectClips(clips, { only: ['send', '0'] }).map((c) => c.id), [0, 1]);
    assert.deepEqual(selectClips(clips, { only: ['A'] }).map((c) => c.id), [2]);
    assert.deepEqual(selectClips(clips, { limit: 2 }).map((c) => c.id), [0, 1]);
    assert.throws(() => selectClips(clips, { only: ['nope'] }), /no clip matches nope/);
});

test('run with a fake API: outputs, retry on 429 and 409, cache hits, key never leaks', async () => {
    const KEY = 'sk_test_SECRET_123';
    const dir = mkdtempSync(join(tmpdir(), 'taktile-audio-'));
    const logs = [];
    const calls = [];
    let first = true;
    let second = true;
    const fakeFetch = async (url, init) => {
        calls.push({ url, init });
        assert.equal(init.headers['xi-api-key'], KEY);
        assert.match(url, /\/v1\/text-to-speech\/VOICE\?output_format=wav_16000$/);
        const body = JSON.parse(init.body);
        assert.equal(body.model_id, DEFAULT_SETTINGS.model_id);
        assert.equal(body.output_format, undefined); // query parameter, not body
        if (first) {
            first = false;
            return new Response(`rate limited ${KEY}`, { status: 429 });
        }
        if (second) {
            second = false;
            return new Response('{"detail":{"status":"already_running"}}', { status: 409 });
        }
        return new Response(writeWav(toneClip()), { status: 200 });
    };
    const clips = [{ id: 0, name: 'W', text: 'aardvark' }, { id: 7, name: 'S', text: 'send' }, { id: 9, name: 'L', text: 'A', say: 'ay' }];
    try {
        const r1 = await run({ clips, apiKey: KEY, voiceId: 'VOICE', outDir: dir, fetchImpl: fakeFetch,
            log: (s) => logs.push(s), sleep: async () => {}, concurrency: 2 });
        assert.equal(r1.generated, 3);
        assert.equal(calls.length, 5); // retried after a 429 and a 409
        assert.ok(calls.some((c) => JSON.parse(c.init.body).text === 'ay')); // `say` is what gets spoken
        assert.deepEqual(readdirSync(join(dir, 'clips')).sort(), ['0.pcm', '7.pcm', '9.pcm']);
        assert.deepEqual(readdirSync(join(dir, 'preview')).sort(), ['000-aardvark.wav', '007-send.wav', '009-a.wav']);
        const pcm = readFileSync(join(dir, 'clips', '7.pcm'));
        assert.equal(pcm.length, 2 * (ms(40) + ms(300) + ms(40)));
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        assert.deepEqual(manifest.map((m) => m.id), [0, 7, 9]);
        assert.equal(manifest[0].peak, peakTarget());

        // Second run: everything from the cache, no API calls.
        const before = calls.length;
        const r2 = await run({ clips, apiKey: KEY, voiceId: 'VOICE', outDir: dir, fetchImpl: fakeFetch, log: (s) => logs.push(s) });
        assert.equal(r2.generated, 0);
        assert.equal(r2.cached, 3);
        assert.equal(calls.length, before);

        // Dry run never calls the API.
        await run({ clips, apiKey: KEY, voiceId: 'VOICE', outDir: dir, fetchImpl: fakeFetch, log: (s) => logs.push(s), force: true, dryRun: true });
        assert.equal(calls.length, before);

        // 401 stops the run with a hint, and the key is redacted from the error.
        const deny = async () => new Response(`invalid key ${KEY}`, { status: 401 });
        await assert.rejects(
            run({ clips, apiKey: KEY, voiceId: 'VOICE', outDir: dir, fetchImpl: deny, log: (s) => logs.push(s), force: true }),
            (e) => /HTTP 401/.test(e.message) && /check ELEVENLABS_API_KEY/.test(e.message) && !e.message.includes(KEY),
        );

        // A response in the wrong format is rejected and not cached.
        const wrong = async () => new Response(Buffer.from('ID3 not wav'), { status: 200 });
        await assert.rejects(
            run({ clips: [{ id: 3, name: 'N', text: 'new' }], apiKey: KEY, voiceId: 'VOICE', outDir: dir, fetchImpl: wrong,
                log: (l) => logs.push(l) }),
            /1 clip\(s\) failed/,
        );
        assert.ok(logs.some((l) => /FAILED clip 3 \("new"\): not a WAV/.test(l)));
        assert.equal(readdirSync(join(dir, 'cache')).length, 3);

        // The key appears in no log line and no output file.
        assert.ok(!logs.join('\n').includes(KEY));
        for (const sub of ['clips', 'preview', 'cache']) {
            for (const f of readdirSync(join(dir, sub))) assert.ok(!readFileSync(join(dir, sub, f)).includes(KEY));
        }
        assert.ok(!readFileSync(join(dir, 'manifest.json'), 'utf8').includes(KEY));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('run refuses to call the API without credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'taktile-audio-'));
    try {
        await assert.rejects(
            run({ clips: [{ id: 0, name: 'W', text: 'x' }], apiKey: undefined, voiceId: 'V', outDir: dir, fetchImpl: async () => assert.fail(), log: () => {} }),
            /must be set in server\/\.env/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
