import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import {
    PayError,
    checkPayment,
    fetchAction,
    findSolflare,
    isRejection,
    payRequest,
    postAction,
    signatureOf,
    type FetchFn,
    type WalletProvider,
} from './pay.ts';
import type { PayRequest } from './requests.ts';
import { DEVNET_USDC_MINT, TOKEN_PROGRAM, usdcAta } from './tx.ts';

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const MAX = key(3);
const DEVICE = key(7);
const REF = key(8);
const EVIL = key(6);
const BLOCKHASH = key(9).toBase58();

const req = (over: Partial<PayRequest> = {}): PayRequest => ({
    id: 'a'.repeat(24),
    recipient: DEVICE.toBase58(),
    token: 'USDC',
    amount: '5000000',
    payer: MAX.toBase58(),
    payerName: 'Max',
    requesterName: 'Henry',
    reference: REF.toBase58(),
    createdAt: 1,
    expiresAt: 2,
    status: 'pending',
    signature: null,
    ...over,
});

/** The transaction server/lib/actions.mjs builds, optionally tampered with. */
function payment(
    token: 'SOL' | 'USDC',
    o: { amount?: bigint; to?: PublicKey; ref?: PublicKey | null; payer?: PublicKey; extra?: boolean } = {},
): Transaction {
    const payer = o.payer ?? MAX;
    const to = o.to ?? DEVICE;
    const amount = o.amount ?? (token === 'SOL' ? 10_000_000n : 5_000_000n);
    let ix: TransactionInstruction;
    if (token === 'SOL') {
        ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: amount });
    } else {
        const data = Buffer.alloc(10);
        data[0] = 12;
        data.writeBigUInt64LE(amount, 1);
        data[9] = 6;
        ix = new TransactionInstruction({
            programId: TOKEN_PROGRAM,
            keys: [
                { pubkey: new PublicKey(usdcAta(payer.toBytes())), isSigner: false, isWritable: true },
                { pubkey: DEVNET_USDC_MINT, isSigner: false, isWritable: false },
                { pubkey: new PublicKey(usdcAta(to.toBytes())), isSigner: false, isWritable: true },
                { pubkey: payer, isSigner: true, isWritable: false },
            ],
            data,
        });
    }
    if (o.ref !== null) {
        ix.keys.push({ pubkey: o.ref ?? REF, isSigner: false, isWritable: false });
    }
    const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH });
    tx.add(ix);
    if (o.extra === true) {
        tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: EVIL, lamports: 1n }));
    }
    // round-trip through the wire format, exactly as the page receives it
    return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

const SOL_REQ = req({ token: 'SOL', amount: '10000000' });

test('checkPayment accepts exactly the requested SOL and USDC payments', () => {
    assert.equal(checkPayment(payment('USDC'), req(), MAX.toBase58()), null);
    assert.equal(checkPayment(payment('SOL'), SOL_REQ, MAX.toBase58()), null);
});

test('checkPayment refuses anything else', () => {
    const m = MAX.toBase58();
    const bad: [Transaction, PayRequest, string][] = [
        [payment('USDC', { to: EVIL }), req(), 'does not pay the requester'],
        [payment('SOL', { to: EVIL }), SOL_REQ, 'does not pay the requester'],
        [payment('USDC', { amount: 5_000_001n }), req(), 'amount'],
        [payment('SOL', { amount: 1n }), SOL_REQ, 'amount'],
        [payment('USDC', { ref: null }), req(), 'reference'],
        [payment('USDC', { ref: EVIL }), req(), 'reference'],
        [payment('USDC', { extra: true }), req(), '2 instructions'],
        [payment('USDC', { payer: EVIL }), req(), 'fee payer'],
        [payment('SOL'), req(), 'not a USDC transfer'],
        [payment('USDC'), SOL_REQ, 'not a SOL transfer'],
    ];
    for (const [tx, r, why] of bad) {
        const got = checkPayment(tx, r, m);
        assert.ok(got !== null && got.includes(why), `${why}: got ${got}`);
    }
});

test('checkPayment refuses an already-signed transaction or extra signers', () => {
    const tx = payment('SOL');
    tx.signatures = [{ publicKey: MAX, signature: Buffer.alloc(64, 1) }];
    assert.match(checkPayment(tx, SOL_REQ, MAX.toBase58()) ?? '', /signed/);
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('fetchAction reads title/description/label and keeps the POST on the Action path', async () => {
    const f: FetchFn = async () =>
        json(200, {
            type: 'action',
            icon: 'x',
            title: 'Payment request from Henry',
            description: '5 USDC',
            label: 'Pay 5 USDC',
            links: {
                actions: [
                    { type: 'transaction', label: 'Pay 5 USDC', href: 'https://t.example/api/actions/request/abc' },
                ],
            },
        });
    const a = await fetchAction(f, '/api/actions/request/abc');
    assert.deepEqual(a, {
        title: 'Payment request from Henry',
        description: '5 USDC',
        label: 'Pay 5 USDC',
        href: '/api/actions/request/abc',
    });
    await assert.rejects(
        fetchAction(async () => json(404, { message: 'This payment request has expired.' }), '/x'),
        /expired/,
    );
    await assert.rejects(
        fetchAction(async () => json(200, { title: 1 }), '/x'),
        PayError,
    );
});

test('postAction sends the account and decodes base64; errors carry the server message', async () => {
    let sent = '';
    const tx = payment('SOL');
    const f: FetchFn = async (_u, init) => {
        sent = String(init?.body);
        return json(200, {
            type: 'transaction',
            transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
        });
    };
    const got = await postAction(f, '/api/actions/request/abc', MAX.toBase58());
    assert.deepEqual(JSON.parse(sent), { account: MAX.toBase58() });
    assert.equal(got.feePayer?.toBase58(), MAX.toBase58());
    await assert.rejects(
        postAction(async () => json(400, { message: 'Your wallet has no devnet USDC account.' }), '/a', 'x'),
        /no devnet USDC/,
    );
    await assert.rejects(
        postAction(async () => json(200, { transaction: '!!' }), '/a', 'x'),
        PayError,
    );
});

function wallet(answer: unknown): WalletProvider & { signed: Transaction[] } {
    const signed: Transaction[] = [];
    return {
        signed,
        isSolflare: true,
        publicKey: MAX,
        connect: async () => true,
        signAndSendTransaction: async (t) => {
            signed.push(t);
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        },
    };
}

const actionFetch =
    (tx: Transaction): FetchFn =>
    async (_url, init) =>
        init?.method === 'POST'
            ? json(200, {
                  type: 'transaction',
                  transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
              })
            : json(200, { title: 'Payment request from Henry', description: 'd', label: 'Pay 5 USDC' });

test('payRequest: the checked transaction goes to Solflare; both signature shapes are understood', async () => {
    const w = wallet({ signature: 'SIG1' });
    assert.equal(await payRequest(actionFetch(payment('USDC')), w, MAX.toBase58(), req()), 'SIG1');
    assert.equal(w.signed.length, 1);
    assert.equal(await payRequest(actionFetch(payment('USDC')), wallet('SIG2'), MAX.toBase58(), req()), 'SIG2');
});

test('payRequest: a wrong transaction never reaches Solflare', async () => {
    const w = wallet('SIG');
    await assert.rejects(
        payRequest(actionFetch(payment('USDC', { to: EVIL })), w, MAX.toBase58(), req()),
        /Not paying/,
    );
    assert.equal(w.signed.length, 0);
});

test('a rejection in Solflare is recognized', async () => {
    const e = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    await assert.rejects(payRequest(actionFetch(payment('USDC')), wallet(e), MAX.toBase58(), req()), (x) =>
        isRejection(x),
    );
    assert.equal(isRejection(new Error('Transaction simulation failed: Blockhash not found')), false);
});

test('findSolflare and signatureOf', () => {
    assert.equal(findSolflare({}), null);
    assert.equal(findSolflare({ solflare: { connect: 1 } }), null);
    const w = wallet('s');
    assert.equal(findSolflare({ solflare: w }), w);
    assert.equal(signatureOf('abc'), 'abc');
    assert.equal(signatureOf({ signature: 'abc' }), 'abc');
    assert.throws(() => signatureOf({}), PayError);
});
