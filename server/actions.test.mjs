// node --test (from server/). Devnet is never called: a fake RPC is injected.

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import { ACTIONS_HEADERS, addressPhrase, formatUnits } from './lib/actions.mjs';
import { TOKEN_PROGRAM, USDC_MINT, usdcAta } from './lib/solana.mjs';
import { createServer, loadConfig } from './server.mjs';

const key = (n) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const DEVICE = key(7);
const MAX = key(3);
const BLOCKHASH = key(9);

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeRpc({ existing = null } = {}) {
    return {
        async signaturesFor() {
            return [];
        },
        async transaction() {
            return null;
        },
        async latestBlockhash() {
            return BLOCKHASH;
        },
        // By default every token account exists.
        async accountExists(address) {
            return existing === null || existing.includes(address);
        },
    };
}

async function start({ rpc = fakeRpc(), env = {}, now } = {}) {
    const config = loadConfig({ TK_REQUESTER_NAME: 'Henry', ...env });
    const cacheDir = mkdtempSync(join(tmpdir(), 'tk-act-'));
    dirs.push(cacheDir);
    const server = createServer({ config, cacheDir, rpc, now, log: () => undefined });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const request = (method, path, { json, headers = {} } = {}) =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString();
                        let parsed = null;
                        try {
                            parsed = JSON.parse(text);
                        } catch {
                            // svg
                        }
                        resolve({ status: res.statusCode, headers: res.headers, json: parsed, text });
                    });
                },
            );
            req.on('error', reject);
            req.end(json === undefined ? undefined : JSON.stringify(json));
        });
    const create = async (over = {}) =>
        (
            await request('POST', '/api/requests', {
                json: { recipient: DEVICE, token: 'USDC', amount: '5000000', payer: MAX, payerName: 'Max', ...over },
                headers: { 'Content-Type': 'application/json' },
            })
        ).json;
    return { request, create, port, close: () => new Promise((r) => server.close(r)) };
}

const hasActionHeaders = (h) => {
    for (const [k, v] of Object.entries(ACTIONS_HEADERS)) {
        assert.equal(h[k.toLowerCase()], v, k);
    }
};

test('address phrase matches the shared vectors (device, app)', () => {
    const v = JSON.parse(readFileSync(new URL('../tests/vectors/checksum.json', import.meta.url), 'utf8'));
    for (const a of v.addr) {
        assert.deepEqual(addressPhrase(new PublicKey(Buffer.from(a.wallet, 'hex')).toBase58()), a.words, a.name);
    }
});

test('formatUnits is exact', () => {
    assert.equal(formatUnits('5000000', 'USDC'), '5');
    assert.equal(formatUnits('10000', 'USDC'), '0.01');
    assert.equal(formatUnits('1', 'SOL'), '0.000000001');
    assert.equal(formatUnits('18446744073709551615', 'SOL'), '18446744073.709551615');
});

test('actions.json, icon and OPTIONS: public, with the Actions headers, from any Origin and Host', async () => {
    const s = await start();
    try {
        const foreign = { Origin: 'https://dial.to', Host: 'abc.trycloudflare.com' };
        const a = await s.request('GET', '/actions.json', { headers: foreign });
        assert.equal(a.status, 200);
        assert.deepEqual(a.json, { rules: [{ pathPattern: '/request/*', apiPath: '/api/actions/request/*' }] });
        hasActionHeaders(a.headers);
        assert.equal(a.headers['x-blockchain-ids'], 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
        const i = await s.request('GET', '/api/actions/icon.svg', { headers: foreign });
        assert.equal(i.status, 200);
        assert.equal(i.headers['content-type'], 'image/svg+xml');
        const o = await s.request('OPTIONS', '/api/actions/request/0123456789abcdef01234567', { headers: foreign });
        assert.equal(o.status, 204);
        hasActionHeaders(o.headers);
    } finally {
        await s.close();
    }
});

test('the localhost-only routes stay localhost-only (no Allow-Origin *, foreign Origin refused)', async () => {
    const s = await start();
    try {
        const r = await s.request('GET', `/api/requests?payer=${MAX}`, { headers: { Origin: 'https://dial.to' } });
        assert.equal(r.status, 403);
        assert.equal(r.headers['access-control-allow-origin'], undefined);
        const t = await s.request('POST', '/api/tts', { json: { text: 'hi' }, headers: { Host: 'abc.trycloudflare.com' } });
        assert.equal(t.status, 403);
    } finally {
        await s.close();
    }
});

test('GET action: title, amount, address phrase, one Pay action; links use TK_PUBLIC_URL', async () => {
    const s = await start({ env: { TK_PUBLIC_URL: 'https://abc.trycloudflare.com/' } });
    try {
        const r = await s.create();
        const g = await s.request('GET', `/api/actions/request/${r.id}`);
        assert.equal(g.status, 200);
        hasActionHeaders(g.headers);
        assert.equal(g.json.type, 'action');
        assert.equal(g.json.title, 'Payment request from Henry');
        assert.equal(g.json.label, 'Pay 5 USDC');
        assert.equal(g.json.icon, 'https://abc.trycloudflare.com/api/actions/icon.svg');
        assert.match(g.json.description, /^5 USDC to /);
        assert.ok(g.json.description.includes(addressPhrase(DEVICE).join(' ')));
        assert.deepEqual(g.json.links.actions, [
            {
                type: 'transaction',
                label: 'Pay 5 USDC',
                href: `https://abc.trycloudflare.com/api/actions/request/${r.id}`,
            },
        ]);
    } finally {
        await s.close();
    }
});

test('GET/POST action: 404 ActionError when unknown, expired or paid', async () => {
    let t = 1_000;
    const paidRpc = fakeRpc();
    const s = await start({ now: () => t, rpc: paidRpc });
    try {
        const unknown = await s.request('GET', '/api/actions/request/0123456789abcdef01234567');
        assert.equal(unknown.status, 404);
        assert.equal(typeof unknown.json.message, 'string');
        hasActionHeaders(unknown.headers);
        assert.equal((await s.request('GET', '/api/actions/request/not-an-id')).status, 404);

        const r = await s.create();
        t += 24 * 60 * 60 * 1000;
        const exp = await s.request('GET', `/api/actions/request/${r.id}`);
        assert.equal(exp.status, 404);
        assert.match(exp.json.message, /expired/);
        const post = await s.request('POST', `/api/actions/request/${r.id}`, { json: { account: MAX } });
        assert.equal(post.status, 404);

        t -= 24 * 60 * 60 * 1000;
        const r2 = await s.create();
        paidRpc.signaturesFor = async () => [{ signature: 'sig', failed: false }];
        paidRpc.transaction = async () => ({
            failed: false,
            accounts: [MAX, usdcAta(new PublicKey(DEVICE)).toBase58(), r2.reference],
            preLamports: [0n, 0n, 0n],
            postLamports: [0n, 0n, 0n],
            tokens: [{ account: usdcAta(new PublicKey(DEVICE)).toBase58(), mint: USDC_MINT.toBase58(), pre: 0n, post: 5_000_000n }],
        });
        const paid = await s.request('GET', `/api/actions/request/${r2.id}`);
        assert.equal(paid.status, 404);
        assert.match(paid.json.message, /already been paid/);
    } finally {
        await s.close();
    }
});

const decode = (b64) => Transaction.from(Buffer.from(b64, 'base64'));

test('POST USDC: unsigned TransferChecked from the payer, reference read-only, devnet blockhash', async () => {
    const s = await start();
    try {
        const r = await s.create();
        const p = await s.request('POST', `/api/actions/request/${r.id}`, {
            json: { account: MAX },
            headers: { Origin: 'https://dial.to', Host: 'abc.trycloudflare.com', 'Content-Type': 'application/json' },
        });
        assert.equal(p.status, 200, p.text);
        hasActionHeaders(p.headers);
        assert.equal(p.json.type, 'transaction');
        assert.equal(p.json.message, 'Pay 5 USDC to Henry');
        const tx = decode(p.json.transaction);
        assert.equal(tx.feePayer?.toBase58(), MAX);
        assert.equal(tx.recentBlockhash, BLOCKHASH);
        assert.ok(tx.signatures.every((s) => s.signature === null), 'the server never signs');
        assert.equal(tx.instructions.length, 1);
        const ix = tx.instructions[0];
        assert.ok(ix.programId.equals(TOKEN_PROGRAM));
        assert.deepEqual([...ix.data], [12, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0, 6]); // TransferChecked 5_000_000, 6 decimals
        const keys = ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
        assert.deepEqual(keys, [
            [usdcAta(new PublicKey(MAX)).toBase58(), false, true],
            [USDC_MINT.toBase58(), false, false],
            [usdcAta(new PublicKey(DEVICE)).toBase58(), false, true],
            [MAX, true, true], // the owner is also the fee payer, so the wire format marks it writable
            [r.reference, false, false],
        ]);
    } finally {
        await s.close();
    }
});

test('POST SOL: a System transfer to the requester with the reference', async () => {
    const s = await start();
    try {
        const r = await s.create({ token: 'SOL', amount: '10000000' });
        const p = await s.request('POST', `/api/actions/request/${r.id}`, { json: { account: MAX } });
        assert.equal(p.status, 200, p.text);
        const tx = decode(p.json.transaction);
        const ix = tx.instructions[0];
        assert.ok(ix.programId.equals(SystemProgram.programId));
        const keys = ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
        assert.deepEqual(keys, [
            [MAX, true, true],
            [DEVICE, false, true],
            [r.reference, false, false],
        ]);
        assert.equal(ix.data.readUInt32LE(0), 2); // Transfer
        assert.equal(ix.data.readBigUInt64LE(4), 10_000_000n);
    } finally {
        await s.close();
    }
});

test('POST refusals: bad JSON, bad account, own request, missing USDC accounts, wrong method', async () => {
    const s = await start({ rpc: fakeRpc({ existing: [usdcAta(new PublicKey(DEVICE)).toBase58()] }) });
    try {
        const r = await s.create();
        const path = `/api/actions/request/${r.id}`;
        const code = async (json) => (await s.request('POST', path, { json })).json?.error;
        assert.equal((await s.request('POST', path, { json: undefined })).status, 400);
        assert.equal(await code({}), 'bad_account');
        assert.equal(await code({ account: 'nope' }), 'bad_account');
        assert.equal(await code({ account: DEVICE }), 'self');
        assert.equal(await code({ account: MAX }), 'no_usdc');
        const big = await s.request('POST', path, { json: { account: MAX, pad: 'x'.repeat(2000) } });
        assert.equal(big.status, 413);
        assert.equal((await s.request('PUT', path)).status, 405);
    } finally {
        await s.close();
    }
    const s2 = await start({ rpc: fakeRpc({ existing: [usdcAta(new PublicKey(MAX)).toBase58()] }) });
    try {
        const r = await s2.create();
        const p = await s2.request('POST', `/api/actions/request/${r.id}`, { json: { account: MAX } });
        assert.equal(p.json.error, 'recipient_no_usdc');
    } finally {
        await s2.close();
    }
});
