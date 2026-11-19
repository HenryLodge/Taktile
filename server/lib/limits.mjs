// Sliding-window request counters. They guard against accidental loops (an app bug calling the API
// over and over and burning credits), not against abuse: they live in memory and reset on restart.

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export const RULES = {
    all: [{ windowMs: MINUTE, max: 300 }],
    stt: [
        { windowMs: MINUTE, max: 12 },
        { windowMs: DAY, max: 300 },
    ],
    tts: [
        { windowMs: MINUTE, max: 60 },
        { windowMs: DAY, max: 1500 },
    ],
    agent: [
        { windowMs: MINUTE, max: 6 },
        { windowMs: DAY, max: 60 },
    ],
};

export function createLimiter({ now = Date.now, rules = RULES } = {}) {
    const hits = new Map(); // bucket -> ascending timestamps

    // Counts one request in `bucket` if every rule allows it. Returns { ok: true }, or
    // { ok: false, retryAfter } with the whole seconds until the oldest counted request leaves its window.
    function take(bucket) {
        const t = now();
        const bucketRules = rules[bucket];
        const longest = Math.max(...bucketRules.map((r) => r.windowMs));
        const list = (hits.get(bucket) ?? []).filter((ts) => t - ts < longest);
        hits.set(bucket, list);
        for (const r of bucketRules) {
            const inWindow = list.filter((ts) => t - ts < r.windowMs);
            if (inWindow.length >= r.max) {
                return { ok: false, retryAfter: Math.max(1, Math.ceil((inWindow[0] + r.windowMs - t) / 1000)) };
            }
        }
        list.push(t);
        return { ok: true };
    }

    return { take };
}
