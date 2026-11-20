// Solana DEVNET access for payment requests and Solana Actions (SECURITY_MODEL I9: the endpoint is a
// constant and is refused unless its genesis hash is devnet's). The server never signs anything: it
// reads devnet and builds unsigned transactions for the payer's own wallet to sign.

import { Connection, PublicKey } from '@solana/web3.js';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** CAIP-2 ID of devnet, for the X-Blockchain-Ids header (@solana/actions BLOCKCHAIN_IDS.devnet). */
export const DEVNET_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

// Pinned constants, the same as app/src/tx.ts and core/include/tk_solana_consts.h (devnet USDC only).
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const DECIMALS = { SOL: 9, USDC: 6 };
export const EXPLORER_TX = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/** A base58 public key string, or null if it isn't one. */
export function publicKeyOrNull(s) {
    if (typeof s !== 'string' || s.length < 32 || s.length > 44) {
        return null;
    }
    try {
        const k = new PublicKey(s);
        return k.toBase58() === s ? k : null;
    } catch {
        return null;
    }
}

/** The wallet's devnet-USDC associated token account (the same derivation as the device). */
export function usdcAta(owner) {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

/**
 * The devnet calls the request store and the Actions endpoints need, in plain values so tests can
 * fake them. Every call checks the genesis hash first (once, retried after a network failure).
 */
export function createDevnetRpc({ url = DEVNET_RPC } = {}) {
    const conn = new Connection(url, 'confirmed');
    let checked = null;
    const devnet = () => {
        checked ??= conn.getGenesisHash().then((g) => {
            if (g !== DEVNET_GENESIS) {
                throw new Error('the RPC endpoint is not Solana devnet');
            }
        });
        checked.catch(() => (checked = null));
        return checked;
    };
    return {
        /** Newest first: [{ signature, failed }]. */
        async signaturesFor(address, limit) {
            await devnet();
            const r = await conn.getSignaturesForAddress(new PublicKey(address), { limit }, 'confirmed');
            return r.map((s) => ({ signature: s.signature, failed: s.err !== null }));
        },
        /** { failed, accounts, preLamports, postLamports, tokens: [{ account, mint, pre, post }] } or null. */
        async transaction(signature) {
            await devnet();
            const t = await conn.getParsedTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
            });
            if (t === null || t.meta === null) {
                return null;
            }
            const accounts = t.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
            const tokens = new Map();
            for (const [side, list] of [
                ['pre', t.meta.preTokenBalances ?? []],
                ['post', t.meta.postTokenBalances ?? []],
            ]) {
                for (const b of list) {
                    const e = tokens.get(b.accountIndex) ?? {
                        account: accounts[b.accountIndex],
                        mint: b.mint,
                        pre: 0n,
                        post: 0n,
                    };
                    e[side] = BigInt(b.uiTokenAmount.amount);
                    tokens.set(b.accountIndex, e);
                }
            }
            return {
                failed: t.meta.err !== null,
                accounts,
                preLamports: t.meta.preBalances.map(BigInt),
                postLamports: t.meta.postBalances.map(BigInt),
                tokens: [...tokens.values()],
            };
        },
        async latestBlockhash() {
            await devnet();
            return (await conn.getLatestBlockhash('confirmed')).blockhash;
        },
        async accountExists(address) {
            await devnet();
            return (await conn.getAccountInfo(new PublicKey(address), 'confirmed')) !== null;
        },
    };
}

/**
 * Was this request paid? Looks at the transactions that mention its `reference` key and accepts the
 * first confirmed, successful one that raised the recipient's SOL (or its USDC token account) by at
 * least the requested amount. Returns { paid: true, signature } or { paid: false }.
 */
export async function verifyPayment(rpc, req) {
    const sigs = await rpc.signaturesFor(req.reference, 10);
    const amount = BigInt(req.amount);
    const recipient = req.recipient;
    const usdcAccount = req.token === 'USDC' ? usdcAta(new PublicKey(recipient)).toBase58() : null;
    const mint = USDC_MINT.toBase58();
    for (const s of sigs) {
        if (s.failed) {
            continue;
        }
        const t = await rpc.transaction(s.signature);
        if (t === null || t.failed || !t.accounts.includes(req.reference)) {
            continue;
        }
        let gained = 0n;
        if (usdcAccount === null) {
            const i = t.accounts.indexOf(recipient);
            if (i >= 0) {
                gained = (t.postLamports[i] ?? 0n) - (t.preLamports[i] ?? 0n);
            }
        } else {
            const b = t.tokens.find((x) => x.account === usdcAccount && x.mint === mint);
            if (b !== undefined) {
                gained = b.post - b.pre;
            }
        }
        if (gained >= amount) {
            return { paid: true, signature: s.signature };
        }
    }
    return { paid: false };
}
