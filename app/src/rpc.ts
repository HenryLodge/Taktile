// Solana DEVNET only (SECURITY_MODEL I9): the endpoint is a constant, not an option, and the app
// refuses to use it unless its genesis hash is devnet's.

import { Connection, PublicKey } from '@solana/web3.js';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export type SigStatus = { state: 'pending' } | { state: 'confirmed' } | { state: 'failed'; error: string };

export interface Rpc {
    balance(pubkey: Uint8Array): Promise<bigint>;
    /** Token amount in base units, or null when the token account does not exist. */
    tokenBalance(tokenAccount: Uint8Array): Promise<bigint | null>;
    latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
    blockHeight(): Promise<number>;
    sendRaw(tx: Uint8Array): Promise<string>;
    signatureStatus(sig: string): Promise<SigStatus>;
}

export class RpcError extends Error {}

function friendly(e: unknown): RpcError {
    const m = e instanceof Error ? e.message : String(e);
    if (/429|too many requests|rate/i.test(m)) {
        return new RpcError('Devnet is rate-limiting. Try again in a few seconds.');
    }
    if (/failed to fetch|network|ECONN|ENOTFOUND/i.test(m)) {
        return new RpcError('Cannot reach Solana devnet. Check the internet connection.');
    }
    return new RpcError(`Devnet error: ${m.slice(0, 200)}`);
}

export function createDevnetRpc(): Rpc {
    const conn = new Connection(DEVNET_RPC, 'confirmed');
    let checked: Promise<void> | null = null;
    const devnet = (): Promise<void> => {
        checked ??= conn.getGenesisHash().then((g) => {
            if (g !== DEVNET_GENESIS) {
                throw new RpcError('The RPC endpoint is not Solana devnet. Refusing to use it.');
            }
        });
        checked.catch(() => (checked = null)); // a network failure is retried next time
        return checked;
    };
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
            await devnet();
            return await fn();
        } catch (e) {
            throw e instanceof RpcError ? e : friendly(e);
        }
    };
    return {
        balance: (pk) => call(async () => BigInt(await conn.getBalance(new PublicKey(pk), 'confirmed'))),
        tokenBalance: (ata) =>
            call(async () => {
                const key = new PublicKey(ata);
                if ((await conn.getAccountInfo(key, 'confirmed')) === null) {
                    return null;
                }
                return BigInt((await conn.getTokenAccountBalance(key, 'confirmed')).value.amount);
            }),
        latestBlockhash: () => call(() => conn.getLatestBlockhash('confirmed')),
        blockHeight: () => call(() => conn.getBlockHeight('confirmed')),
        sendRaw: (tx) => call(() => conn.sendRawTransaction(tx, { preflightCommitment: 'confirmed' })),
        signatureStatus: (sig) =>
            call(async () => {
                const st = (await conn.getSignatureStatuses([sig])).value[0];
                if (st === null || st === undefined) {
                    return { state: 'pending' };
                }
                if (st.err !== null) {
                    return { state: 'failed', error: JSON.stringify(st.err) };
                }
                return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized'
                    ? { state: 'confirmed' }
                    : { state: 'pending' };
            }),
    };
}
