import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { PublicKey } from '@solana/web3.js';

import { txPhrase } from './checksum.ts';
import { signedTransaction, solTransferMessage, verifySignature } from './tx.ts';

interface ParserVector {
    name: string;
    message_hex: string;
    device_pubkey: string;
    expect: { status: string; kind: string | null; amount: string | null; destination: string | null };
}
const parser = JSON.parse(
    readFileSync(new URL('../../tests/vectors/parser.json', import.meta.url), 'utf8'),
) as ParserVector[];
const checksum = JSON.parse(readFileSync(new URL('../../tests/vectors/checksum.json', import.meta.url), 'utf8')) as {
    tx: { name: string; message_hex: string; words: string[] }[];
};

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
// tools/gen-vectors.mjs: BLOCKHASH = base58(sha256("taktile-vector:blockhash"))
const BLOCKHASH = new PublicKey(createHash('sha256').update('taktile-vector:blockhash').digest()).toBase58();

test('Shape A message is byte-identical to the sol_ok parser vector', async () => {
    const v = parser.find((x) => x.name === 'sol_ok');
    assert.ok(v && v.expect.kind === 'sol' && v.expect.destination && v.expect.amount);
    const msg = solTransferMessage(hex(v.device_pubkey), hex(v.expect.destination), BigInt(v.expect.amount), BLOCKHASH);
    assert.equal(Buffer.from(msg).toString('hex'), v.message_hex);

    const c = checksum.tx.find((x) => x.name === 'sol_ok');
    assert.ok(c);
    assert.equal(c.message_hex, v.message_hex);
    assert.deepEqual(await txPhrase(msg), c.words);
});

test('every OK SOL vector rebuilds identically', () => {
    const oks = parser.filter((x) => x.expect.status === 'OK' && x.expect.kind === 'sol');
    assert.ok(oks.length >= 1);
    for (const v of oks) {
        const msg = solTransferMessage(
            hex(v.device_pubkey),
            hex(v.expect.destination ?? ''),
            BigInt(v.expect.amount ?? '0'),
            BLOCKHASH,
        );
        assert.equal(Buffer.from(msg).toString('hex'), v.message_hex, v.name);
    }
});

test('sending to the device itself is refused', () => {
    const d = new Uint8Array(32).fill(7);
    assert.throws(() => solTransferMessage(d, d, 1n, BLOCKHASH), /device itself/);
});

test('signed transaction layout', () => {
    const sig = new Uint8Array(64).fill(9);
    const msg = Uint8Array.of(1, 2, 3);
    assert.deepEqual(Array.from(signedTransaction(sig, msg)), [1, ...sig, 1, 2, 3]);
    assert.throws(() => signedTransaction(new Uint8Array(63), msg));
});

test('signature verification', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const msg = Uint8Array.from(Buffer.from('a legacy message'));
    const sig = new Uint8Array(sign(null, msg, privateKey));
    assert.equal(await verifySignature(raw, msg, sig), true);
    const flipped = sig.slice();
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    assert.equal(await verifySignature(raw, msg, flipped), false);
    assert.equal(await verifySignature(raw, Uint8Array.from(Buffer.from('another message')), sig), false);
    assert.equal(await verifySignature(new Uint8Array(32), msg, sig), false);
    assert.equal(await verifySignature(raw, msg, new Uint8Array(10)), false);
});
