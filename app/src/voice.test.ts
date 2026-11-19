import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    MAX_RECORDING_MS,
    PttController,
    VoiceError,
    transcribe,
    type PttState,
    type Recorder,
    type Recording,
} from './voice.ts';

function harness(opts: { ms?: number; text?: string; startError?: VoiceError; transcribeError?: VoiceError } = {}) {
    const states: PttState[] = [];
    const transcripts: string[] = [];
    const errors: string[] = [];
    const uploads: Recording[] = [];
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    let starts = 0;
    const recorder: Recorder = {
        start: async () => {
            starts++;
            if (opts.startError) {
                throw opts.startError;
            }
        },
        stop: async () => ({ blob: new Blob(['audio']), ms: opts.ms ?? 1500 }),
    };
    const ptt = new PttController({
        recorder,
        transcribe: async (rec) => {
            uploads.push(rec);
            if (opts.transcribeError) {
                throw opts.transcribeError;
            }
            return { text: opts.text ?? 'Send one USDC to Henry.', canned: false };
        },
        onState: (s) => void states.push(s),
        onTranscript: (t) => void transcripts.push(t),
        onError: (e) => void errors.push(e.code),
        setTimer: (fn, ms) => {
            const t = { fn, ms, cancelled: false };
            timers.push(t);
            return () => (t.cancelled = true);
        },
    });
    return { ptt, states, transcripts, errors, uploads, timers, starts: () => starts };
}

const space = (repeat = false, inField = false) => ({ key: ' ', repeat, inField });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('hold Space: record, release: upload, transcript', async () => {
    const h = harness();
    assert.equal(h.ptt.keydown(space()), true);
    await tick();
    assert.equal(h.ptt.state, 'recording');
    assert.equal(h.ptt.keydown(space(true)), true); // auto-repeat: ignored, but still ours
    assert.equal(h.starts(), 1);
    assert.equal(h.ptt.keyup(space()), true);
    await tick();
    await tick();
    assert.deepEqual(h.transcripts, ['Send one USDC to Henry.']);
    assert.deepEqual(h.states, ['arming', 'recording', 'uploading', 'idle']);
    assert.equal(h.timers[0]?.cancelled, true);
});

test('Space in a text field or checkbox is not ours', () => {
    const h = harness();
    assert.equal(h.ptt.keydown(space(false, true)), false);
    assert.equal(h.ptt.keyup(space(false, true)), false);
    assert.equal(h.ptt.keydown({ key: 'Enter', repeat: false, inField: false }), false);
    assert.equal(h.starts(), 0);
});

test('a tap shorter than 400 ms: "too short", nothing uploaded', async () => {
    const h = harness({ ms: 300 });
    await h.ptt.press();
    await h.ptt.release();
    assert.deepEqual(h.errors, ['too_short']);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.ptt.state, 'idle');
});

test('recording stops by itself at 15 s', async () => {
    const h = harness();
    await h.ptt.press();
    assert.equal(h.timers[0]?.ms, MAX_RECORDING_MS);
    h.timers[0]?.fn();
    await tick();
    await tick();
    assert.equal(h.uploads.length, 1);
});

test('talk button toggle: start, then stop', async () => {
    const h = harness();
    await h.ptt.toggle();
    assert.equal(h.ptt.state, 'recording');
    await h.ptt.toggle();
    assert.deepEqual(h.transcripts.length, 1);
});

test('released while the mic is still opening: stops as soon as it is armed', async () => {
    const h = harness();
    const p = h.ptt.press(); // arming
    await h.ptt.release(); // key up before the mic opened
    await p;
    await tick();
    assert.equal(h.uploads.length, 1);
    assert.equal(h.ptt.state, 'idle');
});

test('mic blocked: error, back to idle', async () => {
    const h = harness({ startError: new VoiceError('mic_blocked') });
    await h.ptt.press();
    assert.deepEqual(h.errors, ['mic_blocked']);
    assert.equal(h.ptt.state, 'idle');
});

test('empty transcript: "silence"; a press while uploading is ignored', async () => {
    const h = harness({ text: '   ' });
    await h.ptt.press();
    const r = h.ptt.release();
    await h.ptt.press(); // uploading: ignored
    await r;
    assert.deepEqual(h.errors, ['silence']);
    assert.equal(h.starts(), 1);
});

test('transcribe: request shape and error mapping', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        (async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(body), { status, headers });
        }) as typeof fetch;
    const rec = { blob: new Blob(['x'], { type: 'audio/webm' }), ms: 1000 };

    const ok = await transcribe(rec, ['Henry', 'Mary Jo'], reply(200, { text: 'hi' }, { 'X-TK-Canned': '1' }));
    assert.deepEqual(ok, { text: 'hi', canned: true });
    assert.equal(calls[0]?.url, '/api/stt?names=Henry%2CMary%20Jo');
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['Content-Type'], 'audio/webm');

    const code = async (f: typeof fetch) => {
        try {
            await transcribe(rec, [], f);
            return 'ok';
        } catch (e) {
            return e instanceof VoiceError ? e.code : 'other';
        }
    };
    assert.equal(await code(reply(429, { error: 'rate_limited' })), 'busy');
    assert.equal(await code(reply(429, { error: 'busy' })), 'busy');
    assert.equal(await code(reply(400, { error: 'too_short' })), 'too_short');
    assert.equal(await code(reply(502, { error: 'upstream_auth' })), 'unavailable');
    assert.equal(await code(reply(200, { nope: 1 })), 'unavailable');
    assert.equal(
        await code((async () => {
            throw new TypeError('Failed to fetch');
        }) as typeof fetch),
        'unavailable',
    );
    assert.equal((await transcribe(rec, [], reply(200, { text: 'x' }))).canned, false);
    assert.equal(calls.at(-1)?.url, '/api/stt');
});
