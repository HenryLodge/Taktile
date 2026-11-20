// node --test (from server/). Devnet is never called: every test injects a fake RPC.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PublicKey } from '@solana/web3.js';

import { createRequestStore, REFRESH_MS, TTL_MS } from './lib/requests.mjs';
import { USDC_MINT, usdcAta, verifyPayment } from './lib/solana.mjs';
import { createServer, loadConfig } from './server.mjs';

const key = (n) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const DEVICE = key(7);
const MAX = key(3);
const OTHER = key(5);
const MINT = USDC_MINT.toBase58();
const DEVICE_USDC = usdcAta(new PublicKey(DEVICE)).toBase58();

/** A fake devnet: transactions by signature, and which signatures mention which address. */
function fakeRpc(txs = {}) {
    const calls = [];
    return {
        calls,
        async signaturesFor(address) {
            calls.push(['sigs', address]);
            return Object.entries(txs)
                .filter(([, t]) => t.accounts.includes(address))
                .map(([signature, t]) => ({ signature, failed: t.failed }));
        },
        async transaction(sig) {
            calls.push(['tx', sig]);
            return txs[sig] ?? null;
        },
    };
}

const solPay = (reference, { to = DEVICE, lamports = 10_000_000n, failed = false } = {}) => ({
    failed,
    accounts: [MAX, to, '11111111111111111111111111111111', reference],
    preLamports: [1_000_000_000n, 5n, 1n, 0n],
    postLamports: [1_000_000_000n - lamports - 5000n, 5n + lamports, 1n, 0n],
    tokens: [],
});
const usdcPay = (reference, { units = 5_000_000n, account = DEVICE_USDC } = {}) => ({
    failed: false,
    accounts: [MAX, 'srcAta', MINT, account, reference],
    preLamports: [1n, 0n, 0n, 0n, 0n],
    postLamports: [1n, 0n, 0n, 0n, 0n],
    tokens: [
        { account: 'srcAta', mint: MINT, pre: 9_000_000n, post: 9_000_000n - units },
        { account, mint: MINT, pre: 0n, post: units },
    ],
});

const body = (over = {}) => ({ recipient: DEVICE, token: 'USDC', amount: '5000000', payer: MAX, payerName: 'Max', ...over });

test('create: a pending request with a fresh id and reference, expiring in 24 h', () => {
    const s = createRequestStore({ now: () => 1000 });
    const a = s.create(body());
    const b = s.create(body());
    assert.equal(a.status, 'pending');
    assert.match(a.id, /^[0-9a-f]{24}$/);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.reference, b.reference);
    assert.equal(new PublicKey(a.reference).toBase58(), a.reference);
    assert.equal(a.expiresAt, 1000 + TTL_MS);
    assert.equal(a.requesterName, `Taktile wallet ${DEVICE.slice(0, 4)}…${DEVICE.slice(-4)}`);
    assert.equal(createRequestStore({ requesterName: 'Henry' }).create(body()).requesterName, 'Henry');
    assert.equal(a.blink, `solana-action:http://localhost:8787/api/actions/request/${a.id}`);
    const t = createRequestStore({ publicBase: 'https://abc.trycloudflare.com' }).create(body());
    assert.equal(t.blink, `solana-action:https://abc.trycloudflare.com/api/actions/request/${t.id}`);
});

test('create: every bad field is refused with 400', () => {
    const s = createRequestStore();
    const bad = [
        null,
        body({ recipient: 'nope' }),
        body({ payer: DEVICE }), // from itself
        body({ payer: `${MAX.slice(0, -1)}0` }), // "0" is not base58
        body({ token: 'BONK' }),
        body({ amount: 5 }),
        body({ amount: '0' }),
        body({ amount: '-1' }),
        body({ amount: '1.5' }),
        body({ amount: '18446744073709551616' }),
        body({ payerName: 'x'.repeat(33) }),
        body({ payerName: 'Max\n' }),
    ];
    for (const b of bad) {
        assert.throws(() => s.create(b), (e) => e.status === 400, JSON.stringify(b));
    }
    assert.equal(s.create(body({ amount: '18446744073709551615' })).amount, '18446744073709551615');
});

test('list by recipient or payer, newest first; expiry by the clock', async () => {
    let t = 0;
    const s = createRequestStore({ now: () => t });
    const first = s.create(body());
    t = 10;
    const second = s.create(body({ payer: OTHER, payerName: 'Ann' }));
    assert.deepEqual((await s.list({ recipient: DEVICE })).map((r) => r.id), [second.id, first.id]);
    assert.deepEqual((await s.list({ payer: MAX })).map((r) => r.id), [first.id]);
    assert.deepEqual(await s.list({ payer: DEVICE }), []);
    t = TTL_MS;
    assert.equal((await s.get(first.id))?.status, 'expired');
    assert.equal((await s.get(second.id))?.status, 'pending');
    assert.equal(await s.get('zz'), null);
});

test('paid detection: SOL and USDC with the reference; throttled; marked once', async () => {
    let t = 0;
    const txs = {};
    const rpc = fakeRpc(txs);
    const s = createRequestStore({ now: () => t, rpc });
    const sol = s.create(body({ token: 'SOL', amount: '10000000' }));
    const usdc = s.create(body());
    assert.equal((await s.get(sol.id))?.status, 'pending');
    txs.sigSol = solPay(sol.reference);
    txs.sigUsdc = usdcPay(usdc.reference);
    assert.equal((await s.get(sol.id))?.status, 'pending', 'checked again within REFRESH_MS');
    t += REFRESH_MS;
    const paid = await s.get(sol.id);
    assert.equal(paid?.status, 'paid');
    assert.equal(paid?.signature, 'sigSol');
    assert.match(paid?.explorer ?? '', /sigSol\?cluster=devnet$/);
    assert.equal((await s.get(usdc.id))?.status, 'paid');
    const n = rpc.calls.length;
    t += REFRESH_MS;
    await s.list({ recipient: DEVICE });
    assert.equal(rpc.calls.length, n, 'paid requests are not checked again');
});

test('verifyPayment: wrong recipient, too little, failed, or another token account is not paid', async () => {
    const s = createRequestStore();
    const sol = s.create(body({ token: 'SOL', amount: '10000000' }));
    const usdc = s.create(body());
    const no = async (req, tx) => assert.deepEqual(await verifyPayment(fakeRpc({ sig: tx }), req), { paid: false });
    await no(sol, solPay(sol.reference, { to: OTHER }));
    await no(sol, solPay(sol.reference, { lamports: 9_999_999n }));
    await no(sol, solPay(sol.reference, { failed: true }));
    await no(sol, solPay('somethingElse'));
    await no(usdc, usdcPay(usdc.reference, { units: 4_999_999n }));
    await no(usdc, usdcPay(usdc.reference, { account: usdcAta(new PublicKey(OTHER)).toBase58() }));
    // SOL sent to a USDC request is not a USDC payment
    await no(usdc, solPay(usdc.reference, { lamports: 5_000_000_000n }));
    // more than asked is fine
    assert.equal((await verifyPayment(fakeRpc({ sig: usdcPay(usdc.reference, { units: 6_000_000n }) }), usdc)).paid, true);
});

test('an RPC failure leaves the request pending', async () => {
    const rpc = {
        async signaturesFor() {
            throw new Error('429');
        },
    };
    const s = createRequestStore({ rpc });
    const r = s.create(body());
    assert.equal((await s.get(r.id))?.status, 'pending');
});

// ---- over HTTP ----

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function start(rpc = fakeRpc()) {
    const config = loadConfig({ TK_REQUESTER_NAME: 'Henry' });
    const cacheDir = mkdtempSync(join(tmpdir(), 'tk-req-'));
    dirs.push(cacheDir);
    const server = createServer({ config, cacheDir, rpc, log: () => undefined });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const request = (method, path, { json, headers = {} } = {}) =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json', ...headers } },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
                },
            );
            req.on('error', reject);
            req.end(json === undefined ? undefined : JSON.stringify(json));
        });
    return { request, close: () => new Promise((r) => server.close(r)) };
}

test('HTTP: create, list, get; bad input 400; unknown 404', async () => {
    const { request, close } = await start();
    try {
        const c = await request('POST', '/api/requests', { json: body() });
        assert.equal(c.status, 201);
        assert.equal(c.json.requesterName, 'Henry');
        const l = await request('GET', `/api/requests?payer=${MAX}`);
        assert.equal(l.status, 200);
        assert.deepEqual(l.json.requests.map((r) => r.id), [c.json.id]);
        const g = await request('GET', `/api/requests/${c.json.id}`);
        assert.equal(g.json.id, c.json.id);
        assert.equal((await request('GET', '/api/requests/0123456789abcdef01234567')).status, 404);
        assert.equal((await request('GET', '/api/requests')).status, 400);
        assert.equal((await request('GET', `/api/requests?payer=${MAX}&recipient=${DEVICE}`)).status, 400);
        assert.equal((await request('GET', '/api/requests?payer=junk')).status, 400);
        assert.equal((await request('POST', '/api/requests', { json: body({ token: 'X' }) })).status, 400);
    } finally {
        await close();
    }
});

test('HTTP: requests stay localhost-only (foreign Origin or Host refused)', async () => {
    const { request, close } = await start();
    try {
        const o = await request('POST', '/api/requests', { json: body(), headers: { Origin: 'https://evil.example' } });
        assert.equal(o.status, 403);
        const h = await request('GET', `/api/requests?payer=${MAX}`, { headers: { Host: 'evil.example' } });
        assert.equal(h.status, 403);
    } finally {
        await close();
    }
});
