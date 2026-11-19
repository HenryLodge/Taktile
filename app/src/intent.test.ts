import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AmountError, U64_MAX, formatAmount, parseAmount } from './amount.ts';
import type { AppContact } from './contacts.ts';
import { normalize, parseIntent } from './intent.ts';

const HENRY: AppContact = { name: 'Henry', address: '3jnhQ6a1kZ6uLNQmXcqcA8qwoV9w6PVUeG27ncYyTCq7' };
const MARY: AppContact = { name: 'Mary Jo', address: '11111111111111111111111111111112' };
const OBRIEN: AppContact = { name: "O'Brien", address: '11111111111111111111111111111113' };
const BOOK = [HENRY, MARY, OBRIEN];

const LAMPORTS = 1_000_000_000n;
const USDC = 1_000_000n;

type Row = [text: string, want: { token: 'SOL' | 'USDC'; amount: bigint; to: string } | string];

const ROWS: Row[] = [
    ['send 0.01 SOL to Henry', { token: 'SOL', amount: LAMPORTS / 100n, to: 'Henry' }],
    ['Send 0.01 sol to henry.', { token: 'SOL', amount: LAMPORTS / 100n, to: 'Henry' }],
    ['SEND 1 SOL TO HENRY!', { token: 'SOL', amount: LAMPORTS, to: 'Henry' }],
    ['send five SOL to Henry', { token: 'SOL', amount: 5n * LAMPORTS, to: 'Henry' }],
    ['send two point five sol to Henry', { token: 'SOL', amount: (5n * LAMPORTS) / 2n, to: 'Henry' }],
    ['send zero point zero one sol to Henry', { token: 'SOL', amount: LAMPORTS / 100n, to: 'Henry' }],
    ['send one hundred twenty sol to henry', { token: 'SOL', amount: 120n * LAMPORTS, to: 'Henry' }],
    ['send one hundred and five usdc to henry', { token: 'USDC', amount: 105n * USDC, to: 'Henry' }],
    ['send a hundred usdc to henry', { token: 'USDC', amount: 100n * USDC, to: 'Henry' }],
    ['send twenty five usdc to Henry', { token: 'USDC', amount: 25n * USDC, to: 'Henry' }],
    ['send two thousand usdc to Henry', { token: 'USDC', amount: 2000n * USDC, to: 'Henry' }],
    ['send $5 to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send $5.50 to Henry', { token: 'USDC', amount: 5_500_000n, to: 'Henry' }],
    ['send 5 dollars to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send five dollars to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send 1 dollar to Henry', { token: 'USDC', amount: USDC, to: 'Henry' }],
    ['send 5 USDC to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['Send 5 U.S.D.C. to Henry.', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send 5 usd c to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send 5 u s d c to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send 5 USDCs to Henry', { token: 'USDC', amount: 5n * USDC, to: 'Henry' }],
    ['send 2 sols to Henry', { token: 'SOL', amount: 2n * LAMPORTS, to: 'Henry' }],
    ['send 1,000 SOL to Henry', { token: 'SOL', amount: 1000n * LAMPORTS, to: 'Henry' }],
    ['send .5 SOL to Henry', { token: 'SOL', amount: LAMPORTS / 2n, to: 'Henry' }],
    ['send 0 SOL to Henry', { token: 'SOL', amount: 0n, to: 'Henry' }],
    ['um send 1 sol to henry please', { token: 'SOL', amount: LAMPORTS, to: 'Henry' }],
    ['okay, send 1 SOL to Henry', { token: 'SOL', amount: LAMPORTS, to: 'Henry' }],
    ['pay 3 usdc to Henry', { token: 'USDC', amount: 3n * USDC, to: 'Henry' }],
    ['transfer 3 usdc to Henry', { token: 'USDC', amount: 3n * USDC, to: 'Henry' }],
    ['give 3 usdc to Henry', { token: 'USDC', amount: 3n * USDC, to: 'Henry' }],
    ['send 1 usdc to mary jo', { token: 'USDC', amount: USDC, to: 'Mary Jo' }],
    ["send 1 usdc to o'brien", { token: 'USDC', amount: USDC, to: "O'Brien" }],
    ['send 0.000000001 SOL to Henry', { token: 'SOL', amount: 1n, to: 'Henry' }],
    ['send 0.000001 USDC to Henry', { token: 'USDC', amount: 1n, to: 'Henry' }],
    ['send 5 to Henry', 'no_token'],
    ['send five to Henry', 'no_token'],
    ['send $5 SOL to Henry', 'no_token'],
    ['send SOL to Henry', 'no_amount'],
    ['send to Henry', 'no_amount'],
    ['pay Henry', 'no_amount'],
    ['send Henry 5 SOL', 'no_amount'],
    ['send 0.0000000001 SOL to Henry', 'too_many_decimals'],
    ['send 0.0000001 USDC to Henry', 'too_many_decimals'],
    ['send 99999999999999999999 SOL to Henry', 'too_large'],
    ['send 5 SOL', 'no_name'],
    ['send 5 SOL to', 'no_name'],
    ['send 5 SOL for Henry', 'no_name'],
    ['hello there', 'not_a_command'],
    ['', 'not_a_command'],
    ['send 1 SOL to Henri', 'did_you_mean'],
    ['send 1 SOL to Bob', 'unknown_name'],
];

for (const [text, want] of ROWS) {
    test(`intent: ${JSON.stringify(text)}`, () => {
        const got = parseIntent(text, BOOK);
        if (typeof want === 'string') {
            assert.equal(got.kind, 'error');
            assert.equal(got.kind === 'error' && got.code, want);
        } else {
            assert.equal(got.kind, 'send', got.kind === 'error' ? `${got.code}: ${got.message}` : '');
            if (got.kind === 'send') {
                assert.equal(got.token, want.token);
                assert.equal(got.amount, want.amount);
                assert.equal(got.contact.name, want.to);
            }
        }
    });
}

test('did_you_mean carries the suggestion; never auto-accepted', () => {
    const r = parseIntent('send 1 SOL to Henri', BOOK);
    assert.equal(r.kind, 'error');
    assert.equal(r.kind === 'error' && r.suggestion?.name, 'Henry');
});

test('ambiguous near-misses are unknown, not guessed', () => {
    const r = parseIntent('send 1 SOL to Ann', [
        { name: 'Anna', address: HENRY.address },
        { name: 'Anne', address: MARY.address },
    ]);
    assert.equal(r.kind === 'error' && r.code, 'unknown_name');
});

test('no contacts at all', () => {
    const r = parseIntent('send 1 SOL to Henry', []);
    assert.equal(r.kind === 'error' && r.code, 'no_contacts');
});

test('normalize', () => {
    assert.deepEqual(normalize('Um, send $5 to Henry, please.'), ['send', '$5', 'to', 'henry']);
    assert.deepEqual(normalize('send 1,000.50 U.S.D.C. to Mary-Jo!'), ['send', '1000.50', 'usdc', 'to', 'mary-jo']);
});

test('amount: exact parse and format', () => {
    assert.equal(parseAmount('0.1', 9) + parseAmount('0.2', 9), parseAmount('0.3', 9));
    assert.equal(parseAmount('18446744073.709551615', 9), U64_MAX);
    assert.throws(() => parseAmount('18446744073.709551616', 9), AmountError);
    assert.equal(parseAmount('1.500000000', 9), 1_500_000_000n); // trailing zeros are fine
    for (const bad of ['', '.', '-1', '1e3', '1.2.3', ' 1', '0x10']) {
        assert.throws(() => parseAmount(bad, 9), AmountError, bad);
    }
    assert.equal(formatAmount(10_000_000n, 9), '0.01');
    assert.equal(formatAmount(1_500_000_000n, 9), '1.5');
    assert.equal(formatAmount(5n * USDC, 6), '5');
    assert.equal(formatAmount(0n, 6), '0');
    assert.equal(formatAmount(U64_MAX, 9), '18446744073.709551615');
});

// Transcripts shaped like ElevenLabs scribe output (the probe's actual output first).
const STT: [string, 'SOL' | 'USDC', bigint][] = [
    ['Send one USDC to Henry', 'USDC', USDC], // real device run 2026-11-18
    ['Send 0.01 SOL to Henry', 'SOL', LAMPORTS / 100n], // real device run 2026-11-18
    ['Send one USDC to Henry.', 'USDC', USDC],
    ['Send 1 USDC to Henry.', 'USDC', USDC],
    ['Send $1 to Henry.', 'USDC', USDC],
    ['Send one U.S.D.C. to Henry.', 'USDC', USDC],
    ['Send 0.01 SOL to Henry.', 'SOL', LAMPORTS / 100n],
    ['Send 0.01 sol to Henry.', 'SOL', LAMPORTS / 100n],
    ['Um, send one USDC to Henry, please.', 'USDC', USDC],
];
for (const [text, token, amount] of STT) {
    test(`stt transcript: ${JSON.stringify(text)}`, () => {
        const r = parseIntent(text, BOOK);
        assert.equal(r.kind, 'send', r.kind === 'error' ? r.message : '');
        if (r.kind === 'send') {
            assert.equal(r.token, token);
            assert.equal(r.amount, amount);
            assert.equal(r.contact.name, 'Henry');
        }
    });
}
