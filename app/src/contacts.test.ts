import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContactBook, STORAGE_KEY, validContactName } from './contacts.ts';

const A = '3jnhQ6a1kZ6uLNQmXcqcA8qwoV9w6PVUeG27ncYyTCq7';
const B = '11111111111111111111111111111112';

function memStorage(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

test('device name rules', () => {
    for (const ok of ['Henry', 'A', 'Mary Jo', "O'Brien", 'Jean-Luc', 'abcdefghijkl', 'R2D2']) {
        assert.ok(validContactName(ok), ok);
    }
    for (const bad of ['', ' Henry', 'Henry ', 'Mary  Jo', 'abcdefghijklm', 'Al!ce', 'Zoë', 'a_b']) {
        assert.ok(!validContactName(bad), bad);
    }
});

test('add, find ignoring case, duplicates, bad address, remove, persisted', () => {
    const s = memStorage();
    const book = new ContactBook(s);
    assert.equal(book.add('Henry', A), null);
    assert.equal(book.find('HENRY')?.address, A);
    assert.match(book.add('henry', B) ?? '', /already a contact named/);
    assert.match(book.add('Max', A) ?? '', /already in the list/);
    assert.match(book.add('Max', 'not-base58!') ?? '', /Address/);
    assert.match(book.add('Max', '1111') ?? '', /Address/); // decodes, but not 32 bytes
    assert.match(book.add('Mary  Jo', B) ?? '', /^Name/);
    assert.equal(book.add('  Max  ', `  ${B} `), null); // trimmed
    assert.deepEqual(
        book.list().map((c) => c.name),
        ['Henry', 'Max'],
    );
    assert.deepEqual(new ContactBook(s).list(), book.list()); // reload
    book.remove('max');
    assert.equal(new ContactBook(s).list().length, 1);
});

test('corrupt or hostile storage is ignored', () => {
    assert.deepEqual(new ContactBook(memStorage({ [STORAGE_KEY]: '{not json' })).list(), []);
    const junk = JSON.stringify([
        { name: 'Henry', address: A },
        { name: 'Bad!', address: A },
        { name: 'X', address: 'nope' },
        7,
    ]);
    assert.deepEqual(
        new ContactBook(memStorage({ [STORAGE_KEY]: junk })).list().map((c) => c.name),
        ['Henry'],
    );
});

test('storage that throws: works in memory', () => {
    const throwing = {
        getItem: () => {
            throw new Error('blocked');
        },
        setItem: () => {
            throw new Error('blocked');
        },
    };
    const book = new ContactBook(throwing);
    assert.equal(book.add('Henry', A), null);
    assert.equal(book.list().length, 1);
    assert.equal(new ContactBook(null).list().length, 0);
});

test('onDevice: false for new and old entries, persisted once marked', () => {
    const s = memStorage({ [STORAGE_KEY]: JSON.stringify([{ name: 'Henry', address: A }]) });
    const book = new ContactBook(s);
    assert.equal(book.find('Henry')?.onDevice, false);
    assert.equal(book.add('Max', B), null);
    assert.equal(book.find('Max')?.onDevice, false);
    book.markOnDevice('henry');
    assert.equal(new ContactBook(s).find('Henry')?.onDevice, true);
    assert.equal(new ContactBook(s).find('Max')?.onDevice, false);
});
