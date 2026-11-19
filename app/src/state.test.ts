import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_MAX, chat, getState } from './state.ts';

test('chat entries keep order, role, level and link', () => {
    chat('user', 'send 0.01 SOL to Henry');
    chat('taktile', 'Sent and confirmed.', { link: 'https://explorer.solana.com/tx/x?cluster=devnet' });
    chat('taktile', 'Connect the device first.', { level: 'alert' });
    const [a, b, c] = getState().chat.slice(-3);
    assert.deepEqual([a?.role, b?.role, c?.role, a?.level, c?.level], ['user', 'taktile', 'taktile', 'info', 'alert']);
    assert.equal(b?.link, 'https://explorer.solana.com/tx/x?cluster=devnet');
    assert.equal(a?.link, undefined);
    assert.ok(a !== undefined && b !== undefined && a.id < b.id);
});

test('chat keeps only the newest CHAT_MAX entries', () => {
    for (let i = 0; i < CHAT_MAX + 25; i++) {
        chat('user', `line ${i}`);
    }
    const all = getState().chat;
    assert.equal(all.length, CHAT_MAX);
    assert.equal(all.at(-1)?.text, `line ${CHAT_MAX + 24}`);
    assert.equal(all[0]?.text, 'line 25');
});
