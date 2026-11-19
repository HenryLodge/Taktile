import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_TTS_CHARS, Speaker, sanitize, type AudioPlayer, type FallbackVoice } from './speech.ts';

interface Harness {
    speaker: Speaker;
    played: string[];
    fallbackSaid: string[];
    fetches: string[];
    finish: () => void; // ends the clip that is playing
    fallbacks: string[];
    setStatus: (s: number | 'offline') => void;
    enabled: { on: boolean };
}

function harness(): Harness {
    const played: string[] = [];
    const fallbackSaid: string[] = [];
    const fetches: string[] = [];
    const fallbacks: string[] = [];
    let status: number | 'offline' = 200;
    let pending: (() => void) | null = null;
    const enabled = { on: true };
    const player: AudioPlayer = {
        play: async (clip) => {
            played.push(await clip.text());
            await new Promise<void>((r) => (pending = r));
        },
        stop: () => {
            const p = pending;
            pending = null;
            p?.();
        },
    };
    const fallback: FallbackVoice = {
        speak: async (text) => void fallbackSaid.push(text),
        cancel: () => undefined,
    };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
        const text = (JSON.parse(String(init?.body)) as { text: string }).text;
        fetches.push(text);
        if (status === 'offline') {
            throw new TypeError('Failed to fetch');
        }
        return new Response(status === 200 ? text : 'err', { status });
    }) as typeof fetch;
    const speaker = new Speaker({
        fetch: fetchImpl,
        player,
        fallback,
        enabled: () => enabled.on,
        onFallback: (r) => void fallbacks.push(r),
    });
    return {
        speaker,
        played,
        fallbackSaid,
        fetches,
        fallbacks,
        enabled,
        finish: () => {
            const p = pending;
            pending = null;
            p?.();
        },
        setStatus: (s) => (status = s),
    };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('lines play one at a time, in order', async () => {
    const h = harness();
    const a = h.speaker.speak('one');
    await tick();
    assert.deepEqual(h.played, ['one']);
    const b = h.speaker.speak('two');
    await tick();
    assert.deepEqual(h.played, ['one']); // still playing "one"
    h.finish();
    await a;
    await tick();
    assert.deepEqual(h.played, ['one', 'two']);
    h.finish();
    await b;
});

test('a newer line drops lines still waiting (keep the latest)', async () => {
    const h = harness();
    void h.speaker.speak('first');
    await tick();
    const dropped = h.speaker.speak('stale');
    void h.speaker.speak('latest');
    await dropped; // resolved without playing
    h.finish();
    await tick();
    h.finish();
    await tick();
    assert.deepEqual(h.played, ['first', 'latest']);
});

test('interrupt stops the current line and clears the queue', async () => {
    const h = harness();
    void h.speaker.speak('long status');
    await tick();
    void h.speaker.speak('queued');
    void h.speaker.speak('Rejected on the device.', 'interrupt');
    await tick();
    await tick();
    assert.deepEqual(h.played, ['long status', 'Rejected on the device.']);
});

test('keep lines are not dropped by later normal lines', async () => {
    const h = harness();
    void h.speaker.speak('first');
    await tick();
    const kept = h.speaker.speak('Checksum: a, b, c.', 'keep');
    void h.speaker.speak('later');
    h.finish();
    await tick();
    h.finish();
    await kept;
    await tick();
    assert.deepEqual(h.played.slice(0, 2), ['first', 'Checksum: a, b, c.']);
});

test('speakAndWait resolves when the line ends, or at the timeout', async () => {
    const h = harness();
    const done = h.speaker.speakAndWait('Checksum: x, y, z.', 1000);
    await tick();
    h.finish();
    await done;
    const t0 = Date.now();
    await h.speaker.speakAndWait('never ends', 30);
    assert.ok(Date.now() - t0 < 500);
    h.speaker.stop();
});

test('stop() silences everything', async () => {
    const h = harness();
    const a = h.speaker.speak('a');
    const b = h.speaker.speak('b', 'keep');
    await tick();
    h.speaker.stop();
    await a;
    await b;
    assert.equal(h.speaker.busy, false);
});

test('repeated lines are fetched once (memory cache)', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
        const p = h.speaker.speak('Signing.');
        await tick();
        h.finish();
        await p;
    }
    assert.deepEqual(h.fetches, ['Signing.']);
    assert.equal(h.played.length, 3);
});

for (const s of [502, 429, 'offline'] as const) {
    test(`speech service ${s}: the browser voice says the line`, async () => {
        const h = harness();
        h.setStatus(s);
        await h.speaker.speak('Sent and confirmed.');
        assert.deepEqual(h.fallbackSaid, ['Sent and confirmed.']);
        assert.equal(h.played.length, 0);
        assert.equal(h.fallbacks.length, 1);
        await h.speaker.speak('again');
        assert.equal(h.fallbacks.length, 1); // reported once, not per line
        assert.equal(h.fetches.length, 2); // no retries
    });
}

test('app voice off: nothing fetched or played', async () => {
    const h = harness();
    h.enabled.on = false;
    await h.speaker.speak('anything');
    assert.deepEqual(h.fetches, []);
    assert.deepEqual(h.played, []);
});

test('sanitize: printable ASCII, typography mapped, at most 200 characters on a word boundary', () => {
    assert.equal(sanitize('It’s “done” — ok…'), 'It\'s "done" - ok...');
    assert.equal(sanitize('café  \n line'), 'caf line');
    const long = sanitize('word '.repeat(100));
    assert.ok(long.length <= MAX_TTS_CHARS);
    assert.ok(long.endsWith('word'));
    assert.equal(sanitize('   '), '');
});

test('never starts while the device is speaking; waits, then plays', async () => {
    const played: string[] = [];
    let deviceBusy = true;
    const speaker = new Speaker({
        fetch: (async (_u: string, init?: RequestInit) =>
            new Response((JSON.parse(String(init?.body)) as { text: string }).text)) as typeof fetch,
        player: { play: async (clip) => void played.push(await clip.text()), stop: () => undefined },
        fallback: null,
        enabled: () => true,
        mayStart: () => !deviceBusy,
        gatePollMs: 5,
    });
    const p = speaker.speak('Sent and confirmed.');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(played, []); // held while the device speaks
    deviceBusy = false;
    await p;
    assert.deepEqual(played, ['Sent and confirmed.']);
});

test('stop() while held: the line is dropped, never played', async () => {
    const played: string[] = [];
    const speaker = new Speaker({
        fetch: (async () => new Response('x')) as typeof fetch,
        player: { play: async (clip) => void played.push(await clip.text()), stop: () => undefined },
        fallback: null,
        enabled: () => true,
        mayStart: () => false,
        gatePollMs: 5,
    });
    const p = speaker.speak('held');
    await new Promise((r) => setTimeout(r, 15));
    speaker.stop();
    await p;
    assert.deepEqual(played, []);
});
