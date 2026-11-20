// Taktile Pay (docs/EXTRATASKS.md Part 2 B2), the payer's side: a Blinks client. For each payment
// request addressed to the connected Solflare wallet it fetches the request's Solana Action (GET),
// asks for the transaction (POST { account }), checks that the transaction is exactly the requested
// payment, and hands it to Solflare, whose approval window pops up. Max approves or rejects there.
//
// The payer side never involves the Taktile device. Everything here is laptop-sourced; the payer's
// check of the recipient is the requester's 8-word address phrase (shown with every request).

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

import type { PayRequest } from './requests.ts';
import { DEVNET_USDC_MINT, TOKEN_PROGRAM, USDC_DECIMALS, usdcAta } from './tx.ts';

// ---- Solflare's injected provider (window.solflare) ----

export interface WalletProvider {
    isSolflare?: boolean;
    publicKey?: { toBase58(): string } | null;
    connect(): Promise<unknown>;
    signAndSendTransaction(tx: Transaction): Promise<unknown>;
}

/** The Solflare extension in this browser, or null. */
export function findSolflare(w: unknown = globalThis): WalletProvider | null {
    const p = (w as { solflare?: unknown }).solflare;
    if (typeof p !== 'object' || p === null) {
        return null;
    }
    const s = p as Partial<WalletProvider>;
    return typeof s.connect === 'function' && typeof s.signAndSendTransaction === 'function'
        ? (p as WalletProvider)
        : null;
}

/** Connect and return the wallet address. */
export async function connectWallet(p: WalletProvider): Promise<string> {
    await p.connect();
    const k = p.publicKey?.toBase58();
    if (typeof k !== 'string') {
        throw new PayError('Solflare did not share a wallet address.');
    }
    return k;
}

/** signAndSendTransaction answers with a signature string or { signature } depending on the version. */
export function signatureOf(r: unknown): string {
    const sig = typeof r === 'string' ? r : (r as { signature?: unknown } | null)?.signature;
    if (typeof sig === 'string' && sig.length > 0) {
        return sig;
    }
    if (sig instanceof Uint8Array) {
        throw new PayError('Solflare returned the signature as bytes; check the explorer for the payment.');
    }
    throw new PayError('Solflare did not return a transaction signature.');
}

/** A wallet "no": the user rejected or closed the window. */
export function isRejection(e: unknown): boolean {
    const code = (e as { code?: unknown } | null)?.code;
    const m = e instanceof Error ? e.message : String(e);
    return code === 4001 || /reject|declin|denied|cancel|closed/i.test(m);
}

export class PayError extends Error {}

// ---- The Action round trip ----

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ActionView {
    title: string;
    description: string;
    label: string;
    /** Where the POST goes (links.actions[0].href, or the Action URL itself). */
    href: string;
}

async function json(res: Response, what: string): Promise<unknown> {
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        // not JSON
    }
    if (!res.ok) {
        const m = (body as { message?: unknown } | null)?.message;
        throw new PayError(typeof m === 'string' ? m : `${what} failed (HTTP ${res.status}).`);
    }
    return body;
}

/** GET the Action and keep what the page shows. Relative hrefs resolve against the Action URL. */
export async function fetchAction(fetchFn: FetchFn, url: string): Promise<ActionView> {
    const a = (await json(await fetchFn(url), 'Loading the payment request')) as Record<string, unknown> | null;
    const str = (k: string) => (typeof a?.[k] === 'string' ? (a[k] as string) : null);
    const title = str('title');
    const description = str('description');
    const label = str('label');
    if (title === null || description === null || label === null) {
        throw new PayError('The payment request is not a valid Solana Action.');
    }
    const links = (a?.links as { actions?: unknown } | undefined)?.actions;
    const first = Array.isArray(links) ? (links[0] as { href?: unknown } | undefined) : undefined;
    const href = typeof first?.href === 'string' ? first.href : url;
    // The POST stays on the Action's own path, wherever the link says the server is (a tunnel URL
    // in TK_PUBLIC_URL resolves to the same route): this page always talks to its own server.
    const path = new URL(href, 'http://localhost').pathname;
    return { title, description, label, href: path };
}

/** POST { account } and decode the returned transaction (base64). */
export async function postAction(fetchFn: FetchFn, href: string, account: string): Promise<Transaction> {
    const r = (await json(
        await fetchFn(href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account }),
        }),
        'Preparing the payment',
    )) as { transaction?: unknown } | null;
    if (typeof r?.transaction !== 'string') {
        throw new PayError('The payment request did not return a transaction.');
    }
    try {
        return Transaction.from(Buffer.from(r.transaction, 'base64'));
    } catch {
        throw new PayError('The payment request returned a transaction that cannot be read.');
    }
}

// ---- The check before Solflare sees anything ----

const keysOf = (ix: Transaction['instructions'][number]) =>
    ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 's' : '-'}`);

/**
 * Is `tx` exactly the payment `req` describes, paid by `payer`? Returns null if so, else why not.
 * One instruction (System transfer or USDC TransferChecked), the requested amount to the requester,
 * the reference key last, the payer as fee payer and the only signer, and no signatures yet.
 */
export function checkPayment(tx: Transaction, req: PayRequest, payer: string): string | null {
    const me = new PublicKey(payer);
    if (tx.feePayer?.toBase58() !== payer) {
        return 'the fee payer is not your wallet';
    }
    if (tx.instructions.length !== 1) {
        return `it has ${tx.instructions.length} instructions, not 1`;
    }
    if (tx.signatures.length !== 1 || tx.signatures[0]?.signature !== null) {
        return 'it asks for other signers or is already signed';
    }
    const ix = tx.instructions[0];
    if (ix === undefined) {
        return 'it has no instruction';
    }
    const amount = BigInt(req.amount);
    const recipient = new PublicKey(req.recipient);
    let want: string[];
    if (req.token === 'SOL') {
        if (!ix.programId.equals(SystemProgram.programId)) {
            return 'it is not a SOL transfer';
        }
        if (ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2 || ix.data.readBigUInt64LE(4) !== amount) {
            return 'the amount is not the requested amount';
        }
        want = [`${payer}:s`, `${req.recipient}:-`, `${req.reference}:-`];
    } else {
        if (!ix.programId.equals(TOKEN_PROGRAM)) {
            return 'it is not a USDC transfer';
        }
        const d = ix.data;
        if (d.length !== 10 || d[0] !== 12 || d.readBigUInt64LE(1) !== amount || d[9] !== USDC_DECIMALS) {
            return 'the amount is not the requested amount';
        }
        want = [
            `${new PublicKey(usdcAta(me.toBytes())).toBase58()}:-`,
            `${DEVNET_USDC_MINT.toBase58()}:-`,
            `${new PublicKey(usdcAta(recipient.toBytes())).toBase58()}:-`,
            `${payer}:s`,
            `${req.reference}:-`,
        ];
    }
    const got = keysOf(ix);
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
        return 'it does not pay the requester, or it is missing the request reference';
    }
    return null;
}

/** The whole round trip for one request; resolves with the signature after Solflare sent it. */
export async function payRequest(
    fetchFn: FetchFn,
    wallet: WalletProvider,
    payer: string,
    req: PayRequest,
    action?: ActionView,
): Promise<string> {
    const a = action ?? (await fetchAction(fetchFn, `/api/actions/request/${req.id}`));
    const tx = await postAction(fetchFn, a.href, payer);
    const bad = checkPayment(tx, req, payer);
    if (bad !== null) {
        throw new PayError(`Not paying: the transaction is wrong (${bad}).`);
    }
    return signatureOf(await wallet.signAndSendTransaction(tx));
}
