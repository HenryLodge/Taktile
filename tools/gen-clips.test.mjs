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
    assert.equal(clips.length, 358);
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
    assert.equal(byName.TK_CLIP_WALLET_WIPED.id, 341); // appending never moves an existing ID
    assert.equal(byName.TK_CLIP_SPEAKER_MODE_OFF.id, 350);
    assert.equal(byName.TK_CLIP_DIGIT.text, 'pin digit number');
    assert.equal(byName['TK_CLIP_TWENTY_ONE+3'].text, 'twenty four');
    assert.equal(clips[clips.length - 3].name, 'TK_CLIP_TWENTY_ONE+3');
    assert.equal(byName.TK_CLIP_PRESS_CONFIRM_ADD.text, 'press confirm to add or reject to cancel');
    assert.equal(clips[clips.length - 1].name, 'TK_CLIP_CONTACT_ADDED');
    // Every letter is sent as its spoken name; the text (what the sim prints) stays the letter.
    assert.equal(byName.TK_CLIP_LETTER_A.text, 'A');
    assert.equal(byName['TK_CLIP_LETTER_A+18'].say, 'ess');
    assert.equal(byName['TK_CLIP_LETTER_A+22'].say, 'double you');
    // Picked by listening: A "ey.", D "dee.", H "aitch" with seed 2.
    assert.equal(byName.TK_CLIP_LETTER_A.say, 'ey.');
    assert.equal(byName['TK_CLIP_LETTER_A+3'].say, 'dee.');
    assert.equal(byName['TK_CLIP_LETTER_A+7'].say, 'aitch');
    assert.deepEqual(byName['TK_CLIP_LETTER_A+7'].tts, { seed: 2 });
    assert.equal(clips.filter((c) => c.tts).length, 2); // H and K
    for (let i = 0; i < 26; i++) {
        assert.ok(byName[i === 0 ? 'TK_CLIP_LETTER_A' : `TK_CLIP_LETTER_A+${i}`].say, `letter ${i} has no say`);
    }
});

test('clips: a header change that leaves an ID without text is caught', () => {
    const src = readFileSync(new URL('../core/include/tk_clips.h', import.meta.url), 'utf8');
    const extra = src.replace('    TK_CLIP_STARTING_AT,', '    TK_CLIP_NEW_PROMPT,\n    TK_CLIP_STARTING_AT,');
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
