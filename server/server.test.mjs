// node --test (from server/). ElevenLabs is never called: every test injects a fetch spy.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createServer, loadConfig } from './server.mjs';

const KEY = 'sk_TEST_SECRET_0123456789';
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fetchSpy(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init, calls.length);
    };
    fn.calls = calls;
    return fn;
}

const okJson = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
const okAudio = () => new Response(Buffer.from('ID3fake-mp3-bytes'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });

async function start({ env = {}, argv = [], fetchImpl = fetchSpy(() => okJson({ text: ' hi ' })), now, timeoutMs } = {}) {
    const config = loadConfig({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: 'voice-dev', ...env }, argv);
    const cacheDir = mkdtempSync(join(tmpdir(), 'tk-server-'));
    dirs.push(cacheDir);
    const logs = [];
    const server = createServer({ config, fetchImpl, now, cacheDir, timeoutMs, log: (l) => logs.push(l) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const request = ({ method = 'GET', path = '/api/health', headers = {}, body } = {}) =>
        new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    let json = null;
                    try {
                        json = JSON.parse(buf.toString());
                    } catch {
                        // audio
                    }
                    resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
                });
            });
            req.on('error', reject);
            req.end(body);
        });
    const close = () => new Promise((r) => server.close(r));
    return { request, close, logs, fetchImpl, port };
}

const audio = (n = 4096) => Buffer.alloc(n, 7);
const stt = (s, { path = '/api/stt', type = 'audio/webm;codecs=opus', body = audio(), headers = {} } = {}) =>
    s.request({ method: 'POST', path, headers: { 'Content-Type': type, ...headers }, body });
const tts = (s, text, headers = {}) =>
    s.request({ method: 'POST', path: '/api/tts', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text }) });

function assertNoKey(s, responses) {
    for (const r of responses) {
        assert.ok(!r.body.toString('latin1').includes(KEY), 'key in a response body');
        assert.ok(!JSON.stringify(r.headers).includes(KEY), 'key in response headers');
    }
    for (const l of s.logs) {
        assert.ok(!l.includes(KEY), `key in log: ${l}`);
    }
}

test('health reports mode and availability, never the key', async () => {
    const s = await start();
    const r = await s.request();
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { mode: 'live', stt: true, tts: true });
    assert.equal(r.headers['cache-control'], 'no-store');
    assertNoKey(s, [r]);
    await s.close();

    const n = await start({ env: { ELEVENLABS_API_KEY: '' } });
    assert.deepEqual((await n.request()).json, { mode: 'live', stt: false, tts: false });
    await n.close();
});

test('origin and host checks', async () => {
    const s = await start();
    for (const origin of ['https://evil.example', 'http://evil.example', 'null', 'https://localhost:5173']) {
        const r = await stt(s, { headers: { Origin: origin } });
        assert.equal(r.status, 403, origin);
    }
    assert.equal((await s.request({ headers: { Host: 'evil.com' } })).status, 403);
    assert.equal((await s.request({ headers: { Host: 'localhost.evil.com:8787' } })).status, 403);
    assert.equal(s.fetchImpl.calls.length, 0);
    assert.equal((await s.request({ headers: { Origin: 'http://localhost:5173' } })).status, 200);
    assert.equal((await s.request({ headers: { Origin: 'http://127.0.0.1:5173' } })).status, 200);
    assert.equal((await s.request()).status, 200); // no Origin: curl, probe
    assert.equal((await s.request({ path: '/nope' })).status, 404);
    assert.equal((await s.request({ method: 'GET', path: '/api/stt' })).status, 404);
    await s.close();
});

test('stt validation', async () => {
    const s = await start();
    assert.equal((await stt(s, { type: 'text/plain' })).status, 415);
    assert.equal((await stt(s, { type: '' })).status, 415);
    const big = await stt(s, { body: audio(2 * 1024 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'too_large');
    const short = await stt(s, { body: audio(100) });
    assert.equal(short.status, 400);
    assert.equal(short.json.error, 'too_short');
    for (const names of ['Al!ce', ' Bob', 'Bob ', 'A  B', 'ThirteenChars', 'Henry,', Array(17).fill('A').join(',')]) {
        const r = await stt(s, { path: `/api/stt?names=${encodeURIComponent(names)}` });
        assert.equal(r.status, 400, names);
        assert.equal(r.json.error, 'bad_names');
    }
    assert.equal(s.fetchImpl.calls.length, 0);
    await s.close();
});

test('stt upstream request shape and reply', async () => {
    const s = await start({ fetchImpl: fetchSpy(() => okJson({ text: '  Send one USDC to Henry.  ', words: [], language_code: 'en' })) });
    const r = await stt(s, { path: `/api/stt?names=${encodeURIComponent("Henry,Mary-Jo,O'Neil")}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { text: 'Send one USDC to Henry.' });
    const [call] = s.fetchImpl.calls;
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['xi-api-key'], KEY);
    const form = call.init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('model_id'), 'scribe_v2');
    assert.equal(form.get('language_code'), 'en');
    assert.equal(form.get('tag_audio_events'), 'false');
    assert.deepEqual(form.getAll('keyterms'), ['USDC', 'SOL', 'Henry', 'Mary-Jo', "O'Neil"]);
    const file = form.get('file');
    assert.equal(file.type, 'audio/webm');
    assert.equal(file.name, 'ptt.webm');
    assert.equal(file.size, 4096);
    assertNoKey(s, [r]);
    await s.close();
});

test('stt keyterms json mode and model override', async () => {
    const s = await start({ env: { TK_STT_KEYTERMS_MODE: 'json', TK_STT_MODEL: 'scribe_v1' } });
    await stt(s, { type: 'audio/wav' });
    const form = s.fetchImpl.calls[0].init.body;
    assert.equal(form.get('model_id'), 'scribe_v1');
    assert.deepEqual(form.getAll('keyterms'), ['["USDC","SOL"]']);
    assert.equal(form.get('file').name, 'ptt.wav');
    await s.close();
});

test('stt without a transcript in the reply is a 502', async () => {
    const s = await start({ fetchImpl: fetchSpy(() => okJson({ nope: 1 })) });
    const r = await stt(s);
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'upstream_bad_reply');
    await s.close();
});

test('stt rate limit: 13th within a minute is refused, then allowed again', async () => {
    let t = 1_000_000;
    const s = await start({ now: () => t });
    for (let i = 0; i < 12; i++) {
        assert.equal((await stt(s)).status, 200, `request ${i + 1}`);
    }
    const r = await stt(s);
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'rate_limited');
    assert.ok(Number(r.headers['retry-after']) >= 1);
    assert.equal(s.fetchImpl.calls.length, 12);
    t += 61_000;
    assert.equal((await stt(s)).status, 200);
    await s.close();
});

test('stt: one transcription in flight at a time', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const s = await start({ fetchImpl: fetchSpy(async () => (await gate, okJson({ text: 'first' }))) });
    const first = stt(s);
    while (s.fetchImpl.calls.length === 0) {
        await new Promise((r) => setTimeout(r, 5));
    }
    const second = await stt(s);
    assert.equal(second.status, 429);
    assert.equal(second.json.error, 'busy');
    release();
    assert.equal((await first).json.text, 'first');
    assert.equal((await stt(s)).status, 200); // free again
    await s.close();
});

test('tts: validation, upstream shape, cache hit on the second call', async () => {
    const s = await start({ fetchImpl: fetchSpy(() => okAudio()), env: { ELEVENLABS_APP_VOICE_ID: 'voice-app' } });
    for (const bad of ['', '   ', 'x'.repeat(201), 'café', 'line\nbreak']) {
        const r = await tts(s, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const notJson = await s.request({ method: 'POST', path: '/api/tts', body: 'text=hi' });
    assert.equal(notJson.json.error, 'bad_json');
    assert.equal(s.fetchImpl.calls.length, 0);

    const a = await tts(s, 'Checksum: solo, aardvark, ruffled.');
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-type'], 'audio/mpeg');
    assert.equal(a.headers['x-tk-cache'], 'miss');
    assert.equal(a.body.toString(), 'ID3fake-mp3-bytes');
    const [call] = s.fetchImpl.calls;
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-app?output_format=mp3_22050_32');
    assert.equal(call.init.headers['xi-api-key'], KEY);
    const body = JSON.parse(call.init.body);
    assert.equal(body.text, 'Checksum: solo, aardvark, ruffled.');
    assert.equal(body.model_id, 'eleven_flash_v2_5');
    assert.equal(body.voice_settings.stability, 0.6);

    const b = await tts(s, 'Checksum: solo, aardvark, ruffled.');
    assert.equal(b.status, 200);
    assert.equal(b.headers['x-tk-cache'], 'hit');
    assert.equal(b.body.toString(), 'ID3fake-mp3-bytes');
    assert.equal(s.fetchImpl.calls.length, 1);
    assert.ok(s.logs.some((l) => l.endsWith(' cache')));
    assertNoKey(s, [a, b]);
    await s.close();
});

test('tts voice falls back to ELEVENLABS_VOICE_ID', async () => {
    const s = await start({ fetchImpl: fetchSpy(() => okAudio()) });
    await tts(s, 'Sent.');
    assert.match(s.fetchImpl.calls[0].url, /\/text-to-speech\/voice-dev\?/);
    await s.close();
});

test('tts rate limit counts uncached requests only', async () => {
    let t = 5_000_000;
    const s = await start({ fetchImpl: fetchSpy(() => okAudio()), now: () => t });
    for (let i = 0; i < 60; i++) {
        assert.equal((await tts(s, `phrase ${i}`)).status, 200);
    }
    assert.equal((await tts(s, 'phrase 0')).status, 200); // cached: not counted
    const r = await tts(s, 'phrase 60');
    assert.equal(r.status, 429);
    assert.ok(r.headers['retry-after']);
    t += 61_000;
    assert.equal((await tts(s, 'phrase 60')).status, 200);
    await s.close();
});

test('upstream errors map to safe messages without the key', async () => {
    const cases = [
        [401, {}, 502, 'upstream_auth'],
        [404, {}, 502, 'upstream_voice'],
        [422, {}, 502, 'upstream_rejected'],
        [429, { 'Retry-After': '7' }, 503, 'upstream_busy'],
        [500, {}, 502, 'upstream_error'],
    ];
    for (const [up, hdrs, want, code] of cases) {
        // A hostile upstream body that echoes the key must not get through.
        const s = await start({
            fetchImpl: fetchSpy(() => new Response(JSON.stringify({ detail: { message: `bad key ${KEY}` } }), { status: up, headers: hdrs })),
        });
        const r = await tts(s, `status ${up}`);
        assert.equal(r.status, want, String(up));
        assert.equal(r.json.error, code);
        if (up === 429) {
            assert.equal(r.headers['retry-after'], '7');
        }
        const r2 = await stt(s);
        assert.ok(r2.status >= 500, String(up));
        assertNoKey(s, [r, r2]);
        await s.close();
    }
});

test('a hanging upstream times out with 504', async () => {
    const hang = fetchSpy((_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    const s = await start({ fetchImpl: hang, timeoutMs: 50 });
    const r = await stt(s);
    assert.equal(r.status, 504);
    assert.equal(r.json.error, 'upstream_timeout');
    assert.equal((await tts(s, 'slow')).status, 504);
    await s.close();
});

test('an unreachable upstream is a 502', async () => {
    const s = await start({ fetchImpl: fetchSpy(() => Promise.reject(new TypeError('fetch failed'))) });
    const r = await stt(s);
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'upstream_unreachable');
    await s.close();
});

test('no key in live mode: 503 no_key, nothing called', async () => {
    const s = await start({ env: { ELEVENLABS_API_KEY: '' } });
    assert.equal((await stt(s)).json.error, 'no_key');
    assert.equal((await tts(s, 'hi')).json.error, 'no_key');
    assert.equal(s.fetchImpl.calls.length, 0);
    await s.close();
});

test('canned mode never calls ElevenLabs and needs no key', async () => {
    for (const how of [{ argv: ['--canned'] }, { env: { TK_SERVER_MODE: 'canned' } }]) {
        const s = await start({ ...how, env: { ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '', ...how.env } });
        assert.deepEqual((await s.request()).json, { mode: 'canned', stt: true, tts: true });
        const a = await stt(s);
        assert.equal(a.status, 200);
        assert.deepEqual(a.json, { text: 'send 0.01 SOL to Henry' });
        assert.equal(a.headers['x-tk-canned'], '1');
        const b = await tts(s, 'anything');
        assert.equal(b.status, 200);
        assert.equal(b.headers['content-type'], 'audio/wav');
        assert.equal(b.body.toString('ascii', 0, 4), 'RIFF');
        assert.equal(b.headers['x-tk-canned'], '1');
        assert.equal((await stt(s, { body: audio(10) })).status, 400); // same validation
        assert.equal(s.fetchImpl.calls.length, 0);
        await s.close();
    }
    const c = await start({ argv: ['--canned'], env: { TK_CANNED_TRANSCRIPT: 'send 1 USDC to Henry' } });
    assert.equal((await stt(c)).json.text, 'send 1 USDC to Henry');
    await c.close();
});

test('loadConfig refuses bad mode and port', () => {
    assert.throws(() => loadConfig({ TK_SERVER_MODE: 'mainnet' }), /TK_SERVER_MODE/);
    assert.throws(() => loadConfig({ TK_SERVER_PORT: 'abc' }), /TK_SERVER_PORT/);
    assert.equal(loadConfig({}).port, 8787);
    assert.equal(loadConfig({ ELEVENLABS_VOICE_ID: 'a', ELEVENLABS_APP_VOICE_ID: 'b' }).voiceId, 'b');
});
