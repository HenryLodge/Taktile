// Run: node --experimental-strip-types --test app/src/*.test.ts
// Checks app/src/checksum.ts against tests/vectors/checksum.json (the same vectors core/ uses).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { addressPhrase, addressPhraseIndices, txPhrase, txPhraseIndices } from './checksum.ts';
import { PGP_EVEN_WORDS } from './words.ts';

interface TxVector {
    name: string;
    message_hex: string;
    indices: number[];
    words: string[];
}
interface AddrVector {
    name: string;
    wallet: string;
    indices: number[];
    words: string[];
}

const vectors = JSON.parse(readFileSync(new URL('../../tests/vectors/checksum.json', import.meta.url), 'utf8')) as {
    tx: TxVector[];
    addr: AddrVector[];
};

const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

test('tx phrases match the shared vectors', async () => {
    assert.ok(vectors.tx.length >= 8);
    for (const v of vectors.tx) {
        const msg = fromHex(v.message_hex);
        assert.deepEqual(await txPhraseIndices(msg), v.indices, v.name);
        assert.deepEqual(await txPhrase(msg), v.words, v.name);
    }
});

test('address phrases match the shared vectors', async () => {
    assert.ok(vectors.addr.length >= 6);
    for (const v of vectors.addr) {
        const w = fromHex(v.wallet);
        assert.deepEqual(await addressPhraseIndices(w), v.indices, v.name);
        assert.deepEqual(await addressPhrase(w), v.words, v.name);
    }
});

test('empty message: first bytes of sha256("TK-TX-v1") are 47 24 5a', async () => {
    assert.deepEqual(await txPhraseIndices(new Uint8Array(0)), [0x47, 0x24, 0x5a]);
});

test('address phrase rejects a wallet that is not 32 bytes', async () => {
    await assert.rejects(addressPhrase(new Uint8Array(31)), /32 bytes/);
});

test('word list has 256 entries', () => {
    assert.equal(PGP_EVEN_WORDS.length, 256);
    assert.equal(PGP_EVEN_WORDS[0xe5], 'topmost');
});
