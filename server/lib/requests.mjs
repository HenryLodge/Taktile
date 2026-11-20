// Payment requests (docs/EXTRATASKS.md Part 2 R): "request 5 USDC from Max" in the app creates one
// here; Max's Taktile Pay page picks up the requests addressed to his wallet; devnet decides when it
// is paid. In memory only (a restart forgets them), devnet only, and the server never signs.
//
// Laptop-sourced, like everything on the laptop (SECURITY_MODEL "Command sources"): a compromised
// laptop could change the recipient. The payer's check is the requester's 8-word address phrase,
// which the requester's device speaks ("what is my address").
//
//   POST /api/requests        { recipient, token, amount, payer, payerName? } -> request
//   GET  /api/requests        ?recipient=<base58> or ?payer=<base58> -> { requests: [...] }, newest first
//   GET  /api/requests/:id    -> request
//
// Reading a pending request refreshes it from devnet, at most every REFRESH_MS per request.

import { randomBytes } from 'node:crypto';

import { PublicKey } from '@solana/web3.js';

import { HttpError, readBody, sendJson } from './http.mjs';
import { EXPLORER_TX, publicKeyOrNull, verifyPayment } from './solana.mjs';

export const TTL_MS = 24 * 60 * 60 * 1000;
export const REFRESH_MS = 5000;
export const MAX_REQUESTS = 200;
const U64_MAX = (1n << 64n) - 1n;
const ID_RE = /^[0-9a-f]{24}$/;

const short = (addr) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

export function createRequestStore({ now = Date.now, rpc, requesterName = '', ttlMs = TTL_MS, refreshMs = REFRESH_MS } = {}) {
    const byId = new Map();
    const checkedAt = new Map();

    const statusOf = (r) => (r.status === 'pending' && now() >= r.expiresAt ? 'expired' : r.status);
    const view = (r) => {
        const status = statusOf(r);
        return {
            ...r,
            status,
            ...(r.signature ? { explorer: EXPLORER_TX(r.signature) } : {}),
        };
    };

    function create(body) {
        if (typeof body !== 'object' || body === null) {
            throw new HttpError(400, 'bad_request', 'expected a JSON object');
        }
        const recipient = publicKeyOrNull(body.recipient);
        const payer = publicKeyOrNull(body.payer);
        if (recipient === null || payer === null) {
            throw new HttpError(400, 'bad_request', 'recipient and payer must be base58 public keys');
        }
        if (recipient.equals(payer)) {
            throw new HttpError(400, 'bad_request', 'a wallet cannot request money from itself');
        }
        if (body.token !== 'SOL' && body.token !== 'USDC') {
            throw new HttpError(400, 'bad_request', 'token must be SOL or USDC');
        }
        if (typeof body.amount !== 'string' || !/^\d{1,20}$/.test(body.amount)) {
            throw new HttpError(400, 'bad_request', 'amount must be a whole number of base units, as a string');
        }
        const amount = BigInt(body.amount);
        if (amount === 0n || amount > U64_MAX) {
            throw new HttpError(400, 'bad_request', 'amount must be between 1 and 2^64 - 1 base units');
        }
        const payerName = body.payerName ?? '';
        if (typeof payerName !== 'string' || !/^[\x20-\x7e]{0,32}$/.test(payerName)) {
            throw new HttpError(400, 'bad_request', 'payerName must be up to 32 printable ASCII characters');
        }
        if (byId.size >= MAX_REQUESTS) {
            // Drop the oldest request that is no longer pending; refuse if all are pending.
            const old = [...byId.values()].find((r) => statusOf(r) !== 'pending');
            if (old === undefined) {
                throw new HttpError(429, 'too_many_requests', `at most ${MAX_REQUESTS} open payment requests`);
            }
            byId.delete(old.id);
        }
        const t = now();
        const r = {
            id: randomBytes(12).toString('hex'),
            recipient: recipient.toBase58(),
            token: body.token,
            amount: amount.toString(),
            payer: payer.toBase58(),
            payerName,
            requesterName: requesterName || `Taktile wallet ${short(recipient.toBase58())}`,
            // Any 32 bytes work as a reference: it only has to be unique, never a signer.
            reference: new PublicKey(randomBytes(32)).toBase58(),
            createdAt: t,
            expiresAt: t + ttlMs,
            status: 'pending',
            signature: null,
        };
        byId.set(r.id, r);
        return view(r);
    }

    /** Ask devnet whether a pending request has been paid (throttled; RPC errors leave it pending). */
    async function refresh(r) {
        if (statusOf(r) !== 'pending' || rpc === undefined) {
            return;
        }
        const last = checkedAt.get(r.id) ?? -Infinity;
        if (now() - last < refreshMs) {
            return;
        }
        checkedAt.set(r.id, now());
        try {
            const v = await verifyPayment(rpc, r);
            if (v.paid) {
                r.status = 'paid';
                r.signature = v.signature;
            }
        } catch {
            // devnet unreachable or rate-limiting: try again next time
        }
    }

    async function get(id) {
        const r = ID_RE.test(id) ? byId.get(id) : undefined;
        if (r === undefined) {
            return null;
        }
        await refresh(r);
        return view(r);
    }

    async function list({ recipient, payer }) {
        const rs = [...byId.values()]
            .filter((r) => (recipient === undefined || r.recipient === recipient) && (payer === undefined || r.payer === payer))
            .sort((a, b) => b.createdAt - a.createdAt);
        await Promise.all(rs.slice(0, 20).map(refresh));
        return rs.map(view);
    }

    return { create, get, list };
}

// ---- HTTP handlers (localhost only: server.mjs applies the Origin/Host checks first) ----

export async function handleCreateRequest(req, res, _url, ctx) {
    const raw = await readBody(req, 2048);
    let body;
    try {
        body = JSON.parse(raw.toString('utf8'));
    } catch {
        throw new HttpError(400, 'bad_json', 'body is not JSON');
    }
    sendJson(res, 201, ctx.requests.create(body));
}

export async function handleListRequests(req, res, url, ctx) {
    req.resume();
    const recipient = url.searchParams.get('recipient') ?? undefined;
    const payer = url.searchParams.get('payer') ?? undefined;
    if ((recipient === undefined) === (payer === undefined)) {
        throw new HttpError(400, 'bad_request', 'give exactly one of ?recipient= or ?payer=');
    }
    const key = recipient ?? payer;
    if (publicKeyOrNull(key) === null) {
        throw new HttpError(400, 'bad_request', 'not a base58 public key');
    }
    sendJson(res, 200, { requests: await ctx.requests.list({ recipient, payer }) });
}

export async function handleGetRequest(req, res, url, ctx) {
    req.resume();
    const id = url.pathname.slice('/api/requests/'.length);
    const r = await ctx.requests.get(id);
    if (r === null) {
        throw new HttpError(404, 'not_found', 'no such payment request');
    }
    sendJson(res, 200, r);
}
