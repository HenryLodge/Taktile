import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DAY, MINUTE, createLimiter } from './lib/limits.mjs';

test('per-minute window slides', () => {
    let t = 0;
    const l = createLimiter({ now: () => t, rules: { b: [{ windowMs: MINUTE, max: 2 }] } });
    assert.ok(l.take('b').ok);
    t = 30_000;
    assert.ok(l.take('b').ok);
    t = 40_000;
    assert.deepEqual(l.take('b'), { ok: false, retryAfter: 20 }); // first leaves at 60 s
    t = 60_000;
    assert.ok(l.take('b').ok);
});

test('refused requests are not counted', () => {
    let t = 0;
    const l = createLimiter({ now: () => t, rules: { b: [{ windowMs: MINUTE, max: 1 }] } });
    l.take('b');
    for (let i = 0; i < 5; i++) {
        assert.equal(l.take('b').ok, false);
    }
    t = MINUTE;
    assert.ok(l.take('b').ok);
});

test('daily cap applies across minutes', () => {
    let t = 0;
    const l = createLimiter({ now: () => t, rules: { b: [{ windowMs: MINUTE, max: 5 }, { windowMs: DAY, max: 7 }] } });
    for (let i = 0; i < 7; i++) {
        t = i * MINUTE;
        assert.ok(l.take('b').ok);
    }
    t = 10 * MINUTE;
    const r = l.take('b');
    assert.equal(r.ok, false);
    assert.equal(r.retryAfter, (DAY - 10 * MINUTE) / 1000);
    t = DAY;
    assert.ok(l.take('b').ok);
});

test('buckets are independent', () => {
    const l = createLimiter({ now: () => 0, rules: { a: [{ windowMs: MINUTE, max: 1 }], b: [{ windowMs: MINUTE, max: 1 }] } });
    assert.ok(l.take('a').ok);
    assert.ok(l.take('b').ok);
    assert.equal(l.take('a').ok, false);
});
