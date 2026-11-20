// Solana Actions (the API behind Blinks) for payment requests (docs/EXTRATASKS.md Part 2 B1).
//
//   GET     /actions.json                 -> rules: /request/* -> /api/actions/request/*
//   GET     /api/actions/icon.svg         -> the icon the Action GET points to
//   GET     /api/actions/request/:id      -> ActionGetResponse (404 if unknown, expired or paid)
//   POST    /api/actions/request/:id      { account } -> { type: "transaction", transaction: base64, message }
//   OPTIONS on any of them                -> CORS preflight
//
// These routes are public by design (any Actions client may call them, e.g. through a tunnel), so
// server.mjs serves them before the localhost Origin/Host checks, with Access-Control-Allow-Origin *
// on these routes only (as @solana/actions does). They read the request store and devnet; they never
// create requests and never sign: the transaction goes back unsigned for the payer's own wallet.
// Shapes and headers checked against @solana/actions-spec 2.4.2 and @solana/actions (B0, 2026-11-19).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

import { HttpError, readBody } from './http.mjs';
import { DECIMALS, DEVNET_CHAIN_ID, TOKEN_PROGRAM, USDC_MINT, publicKeyOrNull, usdcAta } from './solana.mjs';

export const ACTION_VERSION = '2.4';

export const ACTIONS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers':
        'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids',
    'Access-Control-Expose-Headers': 'X-Action-Version, X-Blockchain-Ids',
    'X-Action-Version': ACTION_VERSION,
    'X-Blockchain-Ids': DEVNET_CHAIN_ID,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

export const isActionsPath = (path) => path === '/actions.json' || path.startsWith('/api/actions/');

// ---- The 8-word address phrase (docs/AUDIO.md; the same words the device says for "what is my address") ----

const HERE = dirname(fileURLToPath(import.meta.url));
let WORDS = null;
function words() {
    WORDS ??= readFileSync(join(HERE, '..', '..', 'tools', 'data', 'pgp-even-words.txt'), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    if (WORDS.length !== 256) {
        throw new Error('tools/data/pgp-even-words.txt must have 256 words');
    }
    return WORDS;
}

/** SHA256("TK-ADDR-v1" || wallet)[0..8] -> words (core/src/tk_checksum.c, app/src/checksum.ts). */
export function addressPhrase(wallet) {
    const h = createHash('sha256').update('TK-ADDR-v1').update(new PublicKey(wallet).toBuffer()).digest();
    return [...h.subarray(0, 8)].map((b) => words()[b]);
}

// ---- Helpers ----

/** Base units -> exact decimal text ("0.01", "5"). */
export function formatUnits(units, token) {
    const d = BigInt(DECIMALS[token]);
    const v = BigInt(units);
    const whole = v / 10n ** d;
    const frac = (v % 10n ** d).toString().padStart(Number(d), '0').replace(/0+$/, '');
    return frac === '' ? `${whole}` : `${whole}.${frac}`;
}

const short = (addr) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

function send(res, status, obj, type = 'application/json') {
    const body = Buffer.from(type === 'application/json' ? JSON.stringify(obj) : obj);
    res.writeHead(status, { ...ACTIONS_HEADERS, 'Content-Type': type, 'Content-Length': body.length });
    res.end(body);
}

/** An ActionError: `{ message }` (spec), plus our `error` code for logs and tests. */
export function sendActionError(res, status, code, message) {
    send(res, status, { error: code, message });
}

/** Absolute base URL for links and the icon: TK_PUBLIC_URL (a tunnel), else this request's Host. */
function baseUrl(req, config) {
    if (config.publicUrl) {
        return config.publicUrl;
    }
    const host = /^[A-Za-z0-9.:[\]-]{1,255}$/.test(req.headers.host ?? '') ? req.headers.host : 'localhost';
    return `http://${host}`;
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<rect width="256" height="256" rx="48" fill="#0b3d2e"/>
<circle cx="128" cy="128" r="72" fill="none" stroke="#7fe0b0" stroke-width="16"/>
<circle cx="128" cy="128" r="22" fill="#7fe0b0"/>
<text x="128" y="236" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#ffffff">Taktile</text>
</svg>`;

const ID_PATH = /^\/api\/actions\/request\/([0-9a-f]{24})$/;

/** The stored request if it can still be paid; otherwise a 404 ActionError. */
async function payable(ctx, path) {
    const m = ID_PATH.exec(path);
    const r = m === null ? null : await ctx.requests.get(m[1]);
    if (r === null) {
        throw new HttpError(404, 'not_found', 'This payment request does not exist.');
    }
    if (r.status === 'paid') {
        throw new HttpError(404, 'paid', 'This payment request has already been paid.');
    }
    if (r.status === 'expired') {
        throw new HttpError(404, 'expired', 'This payment request has expired.');
    }
    return r;
}

// ---- The transaction (unsigned; the payer's wallet signs) ----

const TRANSFER_CHECKED = 12;

/**
 * The payer's transfer to the requester with the request's `reference` appended as a read-only
 * non-signer key (how paid detection finds it). SOL: System transfer. USDC: SPL Token TransferChecked
 * between the two devnet-USDC token accounts, laid out like app/src/tx.ts.
 */
export function buildPayment(r, payerKey, blockhash) {
    const payer = new PublicKey(payerKey);
    const recipient = new PublicKey(r.recipient);
    const amount = BigInt(r.amount);
    let ix;
    if (r.token === 'SOL') {
        ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: amount });
    } else {
        const data = Buffer.alloc(10);
        data[0] = TRANSFER_CHECKED;
        data.writeBigUInt64LE(amount, 1);
        data[9] = DECIMALS.USDC;
        ix = new TransactionInstruction({
            programId: TOKEN_PROGRAM,
            keys: [
                { pubkey: usdcAta(payer), isSigner: false, isWritable: true },
                { pubkey: USDC_MINT, isSigner: false, isWritable: false },
                { pubkey: usdcAta(recipient), isSigner: false, isWritable: true },
                { pubkey: payer, isSigner: true, isWritable: false },
            ],
            data,
        });
    }
    ix.keys.push({ pubkey: new PublicKey(r.reference), isSigner: false, isWritable: false });
    const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
    tx.add(ix);
    return tx;
}

// ---- Handler ----

export async function handleActions(req, res, url, ctx) {
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
        req.resume();
        res.writeHead(204, ACTIONS_HEADERS);
        res.end();
        return;
    }
    if (req.method === 'GET' && path === '/actions.json') {
        req.resume();
        return send(res, 200, { rules: [{ pathPattern: '/request/*', apiPath: '/api/actions/request/*' }] });
    }
    if (req.method === 'GET' && path === '/api/actions/icon.svg') {
        req.resume();
        return send(res, 200, ICON, 'image/svg+xml');
    }
    if (!ID_PATH.test(path) && !path.startsWith('/api/actions/request/')) {
        req.resume();
        throw new HttpError(404, 'not_found', 'No such action.');
    }
    if (req.method === 'GET') {
        req.resume();
        const r = await payable(ctx, path);
        const base = baseUrl(req, ctx.config);
        const amount = `${formatUnits(r.amount, r.token)} ${r.token}`;
        const label = `Pay ${amount}`;
        return send(res, 200, {
            type: 'action',
            icon: `${base}/api/actions/icon.svg`,
            title: `Payment request from ${r.requesterName}`,
            description: `${amount} to ${short(r.recipient)} on Solana devnet. Address phrase: ${addressPhrase(r.recipient).join(' ')}. Ask the requester to compare it with what their Taktile device says.`,
            label,
            links: { actions: [{ type: 'transaction', label, href: `${base}/api/actions/request/${r.id}` }] },
        });
    }
    if (req.method === 'POST') {
        const raw = await readBody(req, 1024);
        let body;
        try {
            body = JSON.parse(raw.toString('utf8'));
        } catch {
            throw new HttpError(400, 'bad_json', 'The body must be JSON: { "account": "<base58 public key>" }.');
        }
        const payer = publicKeyOrNull(body?.account);
        if (payer === null) {
            throw new HttpError(400, 'bad_account', '"account" must be a base58 public key.');
        }
        const r = await payable(ctx, path);
        if (payer.toBase58() === r.recipient) {
            throw new HttpError(400, 'self', 'You cannot pay your own payment request.');
        }
        const rpc = ctx.rpc;
        if (r.token === 'USDC') {
            if (!(await rpc.accountExists(usdcAta(payer).toBase58()))) {
                throw new HttpError(400, 'no_usdc', 'Your wallet has no devnet USDC account. Get devnet USDC at faucet.circle.com.');
            }
            if (!(await rpc.accountExists(usdcAta(new PublicKey(r.recipient)).toBase58()))) {
                throw new HttpError(400, 'recipient_no_usdc', 'The requester has no devnet USDC account yet.');
            }
        }
        const tx = buildPayment(r, payer.toBase58(), await rpc.latestBlockhash());
        return send(res, 200, {
            type: 'transaction',
            transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
            message: `Pay ${formatUnits(r.amount, r.token)} ${r.token} to ${r.requesterName}`,
        });
    }
    req.resume();
    throw new HttpError(405, 'method', 'Use GET, POST or OPTIONS.');
}
