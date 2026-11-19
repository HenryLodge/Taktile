// Ambiguous names: the app asks which one (src/disambiguate.ts); nothing is guessed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppContact } from './contacts.ts';
import { parseIntent } from './intent.ts';

const USDC = 1_000_000n;
const HENRY: AppContact = { name: 'Henry', address: '3jnhQ6a1kZ6uLNQmXcqcA8qwoV9w6PVUeG27ncYyTCq7' };
const JACKS: AppContact[] = [
    HENRY,
    { name: 'Jack Miller', address: '11111111111111111111111111111114' },
    { name: 'Jack Chen', address: '11111111111111111111111111111115' },
    { name: 'Jackson', address: '11111111111111111111111111111116' },
];

test('a first name shared by two contacts is ambiguous; amount and token are kept', () => {
    const r = parseIntent('send one USDC to Jack', JACKS);
    assert.equal(r.kind, 'ambiguous');
    if (r.kind === 'ambiguous') {
        assert.deepEqual(
            r.candidates.map((c) => c.name),
            ['Jack Miller', 'Jack Chen'],
        ); // not Jackson: whole words only
        assert.equal(r.token, 'USDC');
        assert.equal(r.amount, USDC);
        assert.equal(r.spoken, 'jack');
    }
});

test('the full name is never ambiguous', () => {
    const r = parseIntent('send 1 USDC to jack chen', JACKS);
    assert.equal(r.kind === 'send' && r.contact.name, 'Jack Chen');
    const j = parseIntent('send 1 USDC to Jackson', JACKS);
    assert.equal(j.kind === 'send' && j.contact.name, 'Jackson');
});

test('one contact starting with that word: did_you_mean, not a guess', () => {
    const r = parseIntent('send 1 USDC to Jack', [
        HENRY,
        { name: 'Jack Miller', address: '11111111111111111111111111111114' },
    ]);
    assert.equal(r.kind === 'error' && r.code, 'did_you_mean');
    assert.equal(r.kind === 'error' && r.suggestion?.name, 'Jack Miller');
});

test('a partial word is not a prefix match', () => {
    const r = parseIntent('send 1 USDC to Ja', JACKS);
    assert.equal(r.kind === 'error' && r.code, 'unknown_name');
});

test('three contacts sharing a first name: three candidates', () => {
    const three = [...JACKS, { name: 'Jack Brown', address: '11111111111111111111111111111117' }];
    const r = parseIntent('send 1 USDC to Jack', three);
    assert.equal(r.kind === 'ambiguous' && r.candidates.length, 3);
});
