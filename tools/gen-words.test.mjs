import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { generate, loadWords, parseWords } from './gen-words.mjs';

test('word list: 256 words with known spot entries', () => {
    const w = loadWords();
    assert.equal(w.length, 256);
    assert.equal(w[0x00], 'aardvark');
    assert.equal(w[0x01], 'absurd');
    assert.equal(w[0xe5], 'topmost'); // Wikipedia's worked example: E5 82 -> "topmost Istanbul"
    assert.equal(w[0xff], 'Zulu');
});

test('parseWords rejects bad lists', () => {
    const good = loadWords();
    assert.throws(() => parseWords(good.slice(1).join('\n')), /expected 256/);
    assert.throws(() => parseWords([...good.slice(0, 255), 'Aardvark'].join('\n')), /duplicate/);
    assert.throws(() => parseWords([...good.slice(0, 255), 'two words'].join('\n')), /letters only/);
    assert.equal(parseWords('# comment\n' + good.join('\r\n') + '\n').length, 256);
});

test('generated files are up to date', () => {
    for (const [rel, text] of generate()) {
        const current = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(current, text, `${rel} is stale: run node tools/gen-words.mjs`);
    }
});
