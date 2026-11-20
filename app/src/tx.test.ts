import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { PublicKey } from '@solana/web3.js';

import { txPhrase } from './checksum.ts';
import {
    ATA_PROGRAM,
    DEVNET_USDC_MINT,
    TOKEN_PROGRAM,
    signedTransaction,
    solTransferMessage,
    stakeAccount,
    stakeMessage,
    unstakeMessage,
    usdcAta,
    usdcTransferMessage,
    usdcTransferMessageToAta,
    verifySignature,
} from './tx.ts';

interface ParserVector {
    name: string;
    message_hex: string;
    device_pubkey: string;
    expect: {
        status: string;
        kind: string | null;
        amount: string | null;
        destination: string | null;
        stake_index?: number | null;
    };
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

interface AtaVector {
    name: string;
    wallet: string;
    mint: string;
    ata: string;
}
const ataVectors = JSON.parse(
    readFileSync(new URL('../../tests/vectors/ata.json', import.meta.url), 'utf8'),
) as AtaVector[];

test('Shape B message is byte-identical to the usdc_ok parser vector', async () => {
    const v = parser.find((x) => x.name === 'usdc_ok') as (ParserVector & { device_usdc_ata: string }) | undefined;
    assert.ok(v && v.expect.kind === 'usdc' && v.expect.destination && v.expect.amount);
    const msg = usdcTransferMessageToAta(
        hex(v.device_pubkey),
        hex(v.device_usdc_ata),
        hex(v.expect.destination),
        BigInt(v.expect.amount),
        BLOCKHASH,
    );
    assert.equal(Buffer.from(msg).toString('hex'), v.message_hex);
    const c = checksum.tx.find((x) => x.name === 'usdc_ok');
    assert.ok(c);
    assert.equal(c.message_hex, v.message_hex);
    assert.deepEqual(await txPhrase(msg), c.words);
});

test('every OK USDC vector rebuilds identically', () => {
    const oks = parser.filter((x) => x.expect.status === 'OK' && x.expect.kind === 'usdc') as (ParserVector & {
        device_usdc_ata: string;
    })[];
    assert.ok(oks.length >= 1);
    for (const v of oks) {
        const msg = usdcTransferMessageToAta(
            hex(v.device_pubkey),
            hex(v.device_usdc_ata),
            hex(v.expect.destination ?? ''),
            BigInt(v.expect.amount ?? '0'),
            BLOCKHASH,
        );
        assert.equal(Buffer.from(msg).toString('hex'), v.message_hex, v.name);
    }
});

test('usdcAta matches every devnet-USDC ATA vector', () => {
    const usdc = ataVectors.filter((v) => Buffer.from(hex(v.mint)).equals(DEVNET_USDC_MINT.toBuffer()));
    assert.ok(usdc.length >= 6);
    for (const v of usdc) {
        assert.equal(Buffer.from(usdcAta(hex(v.wallet))).toString('hex'), v.ata, v.name);
    }
});

test('usdcTransferMessage derives both token accounts', () => {
    const v = parser.find((x) => x.name === 'usdc_ok') as (ParserVector & { device_usdc_ata: string }) | undefined;
    assert.ok(v);
    assert.equal(Buffer.from(usdcAta(hex(v.device_pubkey))).toString('hex'), v.device_usdc_ata);
    const to = new Uint8Array(32).fill(5);
    const msg = usdcTransferMessage(hex(v.device_pubkey), to, 1n, BLOCKHASH);
    assert.ok(Buffer.from(msg).includes(Buffer.from(usdcAta(to))));
    assert.ok(!Buffer.from(msg).includes(Buffer.from(to)), 'the wallet itself is not in the message');
});

test('pinned constants agree with tools/gen-consts.mjs', () => {
    const src = readFileSync(new URL('../../tools/gen-consts.mjs', import.meta.url), 'utf8');
    const pinned = (name: string) => new RegExp(`name: '${name}', base58: '([1-9A-HJ-NP-Za-km-z]+)'`).exec(src)?.[1];
    assert.equal(pinned('TK_TOKEN_PROGRAM_ID'), TOKEN_PROGRAM.toBase58());
    assert.equal(pinned('TK_ATA_PROGRAM_ID'), ATA_PROGRAM.toBase58());
    assert.equal(pinned('TK_DEVNET_USDC_MINT'), DEVNET_USDC_MINT.toBase58());
});

test('USDC amount range and self-send', () => {
    const d = new Uint8Array(32).fill(7);
    assert.throws(() => usdcTransferMessage(d, d, 1n, BLOCKHASH), /device itself/);
    assert.throws(() => usdcTransferMessage(d, new Uint8Array(32).fill(1), 1n << 64n, BLOCKHASH), /range/);
});

test('Shapes C and D are byte-identical to every OK stake and unstake vector (pinned validator)', async () => {
    const { VALIDATOR } = await import('./validator.ts');
    const oks = parser.filter(
        (x) => x.expect.status === 'OK' && (x.expect.kind === 'stake' || x.expect.kind === 'unstake'),
    );
    assert.ok(oks.length >= 5);
    for (const v of oks) {
        const n = v.expect.stake_index ?? -1;
        const device = hex(v.device_pubkey);
        const msg =
            v.expect.kind === 'stake'
                ? await stakeMessage(device, n, BigInt(v.expect.amount ?? '0'), VALIDATOR.voteAccount, BLOCKHASH)
                : await unstakeMessage(device, n, BLOCKHASH);
        assert.equal(Buffer.from(msg).toString('hex'), v.message_hex, v.name);
        assert.equal(
            Buffer.from((await stakeAccount(device, n)).toBytes()).toString('hex'),
            v.expect.destination,
            v.name,
        );
    }
    await assert.rejects(stakeAccount(hex(oks[0]?.device_pubkey ?? ''), 16));
});
