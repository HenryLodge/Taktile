// Voice commands beyond "send" (docs/EXTRATASKS.md Part 1 V1): every phrasing in the command table,
// leading filler, and near-misses that must not turn into the wrong command.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppContact } from './contacts.ts';
import { parseIntent, type Intent } from './intent.ts';

const LAMPORTS = 1_000_000_000n;
const USDC = 1_000_000n;
const HENRY: AppContact = { name: 'Henry', address: '3jnhQ6a1kZ6uLNQmXcqcA8qwoV9w6PVUeG27ncYyTCq7' };
const MAX: AppContact = { name: 'Max', address: '11111111111111111111111111111112' };
const JACKS: AppContact[] = [
    { name: 'Jack Miller', address: '11111111111111111111111111111114' },
    { name: 'Jack Chen', address: '11111111111111111111111111111115' },
];
const BOOK = [HENRY, MAX, ...JACKS];

/** The intent minus fields that are awkward to compare; contacts by name. */
function shape(i: Intent): Record<string, unknown> {
    const out: Record<string, unknown> = { ...i };
    if ('contact' in i) {
        out.contact = i.contact?.name ?? null;
    }
    delete out.message;
    delete out.suggestion;
    delete out.amountText;
    return out;
}

type Row = [text: string, want: Record<string, unknown>];
const ROWS: Row[] = [
    // money
    ['send 5 USDC to Max', { kind: 'send', token: 'USDC', amount: 5n * USDC, contact: 'Max' }],
    ['request 5 USDC from Max', { kind: 'request', token: 'USDC', amount: 5n * USDC, contact: 'Max' }],
    ['Request five dollars from max.', { kind: 'request', token: 'USDC', amount: 5n * USDC, contact: 'Max' }],
    ['ask Max for 5 USDC', { kind: 'request', token: 'USDC', amount: 5n * USDC, contact: 'Max' }],
    ['ask Jack Chen for 0.5 SOL', { kind: 'request', token: 'SOL', amount: LAMPORTS / 2n, contact: 'Jack Chen' }],
    ['stake 2 SOL', { kind: 'stake', amount: 2n * LAMPORTS }],
    ['stake two sol', { kind: 'stake', amount: 2n * LAMPORTS }],
    ['stake 2', { kind: 'stake', amount: 2n * LAMPORTS }],
    ['unstake', { kind: 'unstake', all: false }],
    ['unstake all', { kind: 'unstake', all: true }],
    ['Unstake everything.', { kind: 'unstake', all: true }],
    // info
    ['what is my balance', { kind: 'balance', token: null }],
    ["what's my balance?", { kind: 'balance', token: null }],
    ['check my SOL balance', { kind: 'balance', token: 'SOL' }],
    ['how much USDC do I have', { kind: 'balance', token: 'USDC' }],
    ['How much SOL do I have?', { kind: 'balance', token: 'SOL' }],
    ['how much do I have', { kind: 'balance', token: null }],
    ['how much do I have staked', { kind: 'staked' }],
    ['how much SOL is staked', { kind: 'staked' }],
    ["what's my stake", { kind: 'staked' }],
    ['what was my last transaction', { kind: 'activity' }],
    ['What was my last transfer?', { kind: 'activity' }],
    ['recent activity', { kind: 'activity' }],
    ['show my recent transactions', { kind: 'activity' }],
    ['do I have any requests', { kind: 'requests', contact: null }],
    ['any pending requests?', { kind: 'requests', contact: null }],
    ['did Max pay me', { kind: 'requests', contact: 'Max' }],
    ['Has Henry paid me yet?', { kind: 'requests', contact: 'Henry' }],
    // device
    ['what is my address', { kind: 'address' }],
    ["What's my address?", { kind: 'address' }],
    ['say my address phrase', { kind: 'address' }],
    ['who are my contacts', { kind: 'contacts' }],
    ['list my contacts', { kind: 'contacts' }],
    ['how many contacts do I have', { kind: 'contacts' }],
    ['lock', { kind: 'lock' }],
    ['lock my wallet', { kind: 'lock' }],
    ['Lock the device.', { kind: 'lock' }],
    // control
    ['repeat that', { kind: 'repeat' }],
    ['say that again', { kind: 'repeat' }],
    ['cancel', { kind: 'cancel' }],
    ['stop', { kind: 'cancel' }],
    ['stop talking', { kind: 'cancel' }],
    ['help', { kind: 'help' }],
    ['what can I say', { kind: 'help' }],
    // leading filler
    ['hey Taktile, what is my balance', { kind: 'balance', token: null }],
    ['Hey tactile, lock my wallet.', { kind: 'lock' }],
    ['can you please tell me my address', { kind: 'address' }],
    ['could you send 1 SOL to Henry', { kind: 'send', token: 'SOL', amount: LAMPORTS, contact: 'Henry' }],
    ['um, can you stake 1 SOL please', { kind: 'stake', amount: LAMPORTS }],
    ['I want to unstake all', { kind: 'unstake', all: true }],
    ['would you repeat that', { kind: 'repeat' }],
];

for (const [text, want] of ROWS) {
    test(`command: ${JSON.stringify(text)}`, () => {
        const got = parseIntent(text, BOOK);
        assert.deepEqual(shape(got), want, got.kind === 'error' ? got.message : '');
    });
}

const ERRORS: [string, string][] = [
    ['send', 'no_amount'],
    ['send to Max', 'no_amount'],
    ['request', 'no_amount'],
    ['request 5 USDC', 'no_name'],
    ['request 5 USDC from', 'no_name'],
    ['request 5 from Max', 'no_token'],
    ['ask Max for money', 'no_amount'],
    ['ask Max', 'no_amount'],
    ['request 5 USDC from Bob', 'unknown_name'],
    ['request 5 USDC from Jack', 'ambiguous_name'],
    ['stake', 'no_amount'],
    ['stake 2 USDC', 'only_sol'],
    ['stake five dollars', 'only_sol'],
    ['stake $5', 'only_sol'],
    ['did Bob pay me', 'unknown_name'],
    ['lock it up', 'not_a_command'],
    ['hey Taktile', 'not_a_command'],
    ['what is the weather', 'not_a_command'],
];
for (const [text, code] of ERRORS) {
    test(`near-miss: ${JSON.stringify(text)} -> ${code}`, () => {
        const got = parseIntent(text, BOOK);
        assert.equal(got.kind, 'error', `got ${got.kind}`);
        assert.equal(got.kind === 'error' && got.code, code, got.kind === 'error' ? got.message : '');
    });
}

test('info phrases with a send verb in them never become a send', () => {
    for (const text of ['what was my last transfer', 'did Max pay me', 'my last payment', 'recent transfers']) {
        assert.notEqual(parseIntent(text, BOOK).kind, 'send', text);
    }
});

test('"stake" questions are not stake commands, and stake commands are not questions', () => {
    assert.equal(parseIntent('how much is staked', BOOK).kind, 'staked');
    assert.equal(parseIntent('stake 1 SOL', BOOK).kind, 'stake');
    assert.equal(parseIntent('unstake', BOOK).kind, 'unstake');
});

test('a name that sounds like a command is still a recipient', () => {
    const book = [...BOOK, { name: 'Lock', address: '11111111111111111111111111111116' }];
    const r = parseIntent('send 1 SOL to Lock', book);
    assert.equal(r.kind === 'send' && r.contact.name, 'Lock');
});

test('the not-a-command message points to help', () => {
    const r = parseIntent('hello there', BOOK);
    assert.equal(r.kind === 'error' && /help/i.test(r.message), true);
});

test('stake keeps the spoken amount text', () => {
    const r = parseIntent('stake 2.5 SOL', BOOK);
    assert.equal(r.kind === 'stake' && r.amountText, '2.5');
});
