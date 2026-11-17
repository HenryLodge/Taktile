import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyOne, verifyText } from './verify-ed25519.mjs';

// RFC 8032 section 7.1, tests 1-3.
const RFC = [
    {
        pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        msg: '',
        sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    },
    {
        pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
        msg: '72',
        sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    },
    {
        pub: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
        msg: 'af82',
        sig: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
    },
];

const line = (v) => `ED25519 pub=${v.pub} msg=${v.msg} sig=${v.sig}`;
const flip = (hex, i) => hex.slice(0, i) + ((parseInt(hex[i], 16) ^ 1).toString(16)) + hex.slice(i + 1);

test('RFC 8032 vectors 1-3 verify', () => {
    for (const v of RFC) {
        assert.equal(verifyOne(v.pub, v.msg, v.sig), true);
    }
});

test('a flipped bit in signature, message or key fails', () => {
    const v = RFC[2];
    assert.equal(verifyOne(v.pub, v.msg, flip(v.sig, 5)), false);
    assert.equal(verifyOne(v.pub, flip(v.msg, 1), v.sig), false);
    assert.equal(verifyOne(flip(v.pub, 3), v.msg, v.sig), false);
});

test('finds every line in device output, mixed with other text', () => {
    const text = `step 0 (Ed25519):\n  RFC ... PASS\n${line(RFC[0])}\r\nnoise\n${line({ ...RFC[1], sig: flip(RFC[1].sig, 0) })}\n`;
    const r = verifyText(text);
    assert.deepEqual(r.map((x) => x.ok), [true, false]);
});

test('no lines -> nothing found', () => {
    assert.deepEqual(verifyText('step 0: FAIL\n'), []);
});
