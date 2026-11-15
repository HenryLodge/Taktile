import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildClips, generate, parseClipEnum } from './gen-clips.mjs';
import { loadWords } from './gen-words.mjs';

test('parseClipEnum: values, expressions, comments', () => {
    const src = `typedef enum {
        A = 0, // first
        B,
        C = A + 10,
        D, /* block */
        E = 7,
        COUNT
    } tk_clip_t;`;
    assert.deepEqual(parseClipEnum(src), [
        { name: 'A', value: 0 }, { name: 'B', value: 1 }, { name: 'C', value: 10 },
        { name: 'D', value: 11 }, { name: 'E', value: 7 }, { name: 'COUNT', value: 8 },
    ]);
    assert.throws(() => parseClipEnum('typedef enum { A = B } tk_clip_t;'), /used before/);
    assert.throws(() => parseClipEnum('typedef enum { A = 1 << 2 } tk_clip_t;'), /unsupported/);
});

test('clips: one per ID 0..TK_CLIP_COUNT-1, words and anchors in place', () => {
    const clips = buildClips();
    assert.equal(clips.length, 342);
    clips.forEach((c, i) => assert.equal(c.id, i));
    assert.equal(new Set(clips.map((c) => c.name)).size, clips.length);
    const words = loadWords();
    for (let i = 0; i < 256; i++) assert.equal(clips[i].text, words[i]);
    const byName = Object.fromEntries(clips.map((c) => [c.name, c]));
    assert.equal(byName.TK_CLIP_ZERO.text, 'zero');
    assert.equal(byName['TK_CLIP_ZERO+19'].text, 'nineteen');
    assert.equal(byName.TK_CLIP_TWENTY.text, 'twenty');
    assert.equal(byName['TK_CLIP_LETTER_A+25'].text, 'Z');
    assert.equal(byName.TK_CLIP_UNKNOWN_RECIPIENT.text, 'unknown recipient, do not sign');
    assert.equal(clips[clips.length - 1].name, 'TK_CLIP_WALLET_WIPED');
});

test('clips: a header change that leaves an ID without text is caught', () => {
    const src = readFileSync(new URL('../core/include/tk_clips.h', import.meta.url), 'utf8');
    const extra = src.replace('    TK_CLIP_COUNT', '    TK_CLIP_NEW_PROMPT,\n    TK_CLIP_COUNT');
    assert.throws(() => buildClips(extra), /no text for TK_CLIP_NEW_PROMPT/);
    const renamed = src.replace('TK_CLIP_REPEAT,', 'TK_CLIP_AGAIN,');
    assert.throws(() => buildClips(renamed), /TK_CLIP_REPEAT, which is not in/);
});

test('generated files are up to date', () => {
    for (const [rel, text] of generate()) {
        const current = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(current, text, `${rel} is stale: run node tools/gen-clips.mjs`);
    }
});
