// Solana DEVNET only (SECURITY_MODEL I9): the endpoint is a constant, not an option, and the app
// refuses to use it unless its genesis hash is devnet's.

import { Connection, PublicKey, type ParsedAccountData, type ParsedTransactionWithMeta } from '@solana/web3.js';

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
    // Read-only queries for the voice commands (src/queries.ts): informational, never signing input.
    /** Newest first. */
    signaturesFor(address: Uint8Array, limit: number): Promise<SigInfo[]>;
    /** One entry per signature, null when devnet doesn't have it (yet). */
    transactions(sigs: string[]): Promise<(TxInfo | null)[]>;
    /** One entry per address, null when the account doesn't exist or isn't a stake account. */
    stakeAccounts(addresses: Uint8Array[]): Promise<(StakeInfo | null)[]>;
    epoch(): Promise<bigint>;
    /** Lamports a `space`-byte account needs to be rent-exempt (a stake account: 200 bytes). */
    rentExempt(space: number): Promise<bigint>;
    /** The smallest delegation the stake program accepts (devnet: 1 SOL, 2026-11-19). */
    minimumDelegation(): Promise<bigint>;
}

export interface SigInfo {
    signature: string;
    slot: number;
}

/** What src/queries.ts needs from a parsed transaction; addresses are base58. */
export interface TxInfo {
    signature: string;
    slot: number;
    blockTime: number | null;
    failed: boolean;
    fee: bigint;
    accounts: string[];
    preLamports: bigint[];
    postLamports: bigint[];
    /** Token balances by account, merged from pre and post (a missing side is 0). */
    tokens: { owner: string; mint: string; pre: bigint; post: bigint }[];
}

/** A stake account; the epochs are null until it is delegated. */
export interface StakeInfo {
    lamports: bigint;
    activationEpoch: bigint | null;
    deactivationEpoch: bigint | null;
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

function txInfo(signature: string, t: ParsedTransactionWithMeta | null): TxInfo | null {
    if (t === null || t.meta === null) {
        return null;
    }
    const meta = t.meta;
    const accounts = t.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const tokens = new Map<number, { owner: string; mint: string; pre: bigint; post: bigint }>();
    for (const [side, list] of [
        ['pre', meta.preTokenBalances ?? []],
        ['post', meta.postTokenBalances ?? []],
    ] as const) {
        for (const b of list) {
            const e = tokens.get(b.accountIndex) ?? { owner: b.owner ?? '', mint: b.mint, pre: 0n, post: 0n };
            e[side] = BigInt(b.uiTokenAmount.amount);
            tokens.set(b.accountIndex, e);
        }
    }
    return {
        signature,
        slot: t.slot,
        blockTime: t.blockTime ?? null,
        failed: meta.err !== null,
        fee: BigInt(meta.fee),
        accounts,
        preLamports: meta.preBalances.map(BigInt),
        postLamports: meta.postBalances.map(BigInt),
        tokens: [...tokens.values()],
    };
}

const U64_MAX_TEXT = '18446744073709551615';

function stakeInfo(lamports: number, data: Buffer | ParsedAccountData): StakeInfo | null {
    if (data instanceof Uint8Array || data.program !== 'stake') {
        return null;
    }
    const parsed = data.parsed as {
        type?: string;
        info?: { stake?: { delegation?: { activationEpoch?: string; deactivationEpoch?: string } } };
    };
    const d = parsed.info?.stake?.delegation;
    if (parsed.type !== 'delegated' || d?.activationEpoch === undefined) {
        return { lamports: BigInt(lamports), activationEpoch: null, deactivationEpoch: null };
    }
    return {
        lamports: BigInt(lamports),
        activationEpoch: BigInt(d.activationEpoch),
        deactivationEpoch:
            d.deactivationEpoch === undefined || d.deactivationEpoch === U64_MAX_TEXT
                ? null
                : BigInt(d.deactivationEpoch),
    };
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
        signaturesFor: (address, limit) =>
            call(async () =>
                (await conn.getSignaturesForAddress(new PublicKey(address), { limit }, 'confirmed')).map((x) => ({
                    signature: x.signature,
                    slot: x.slot,
                })),
            ),
        transactions: (sigs) =>
            call(async () => {
                if (sigs.length === 0) {
                    return [];
                }
                const txs = await conn.getParsedTransactions(sigs, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0,
                });
                // Match by the transaction's own signature: devnet's batch replies can come back in a
                // different order from the request (seen 2026-11-19).
                const bySig = new Map<string, ParsedTransactionWithMeta>();
                for (const t of txs) {
                    const sig = t?.transaction.signatures[0];
                    if (t !== null && sig !== undefined) {
                        bySig.set(sig, t);
                    }
                }
                return sigs.map((sig) => txInfo(sig, bySig.get(sig) ?? null));
            }),
        stakeAccounts: (addresses) =>
            call(async () => {
                const keys = addresses.map((a) => new PublicKey(a));
                const r = await conn.getMultipleParsedAccounts(keys, { commitment: 'confirmed' });
                return r.value.map((acc) => (acc === null ? null : stakeInfo(acc.lamports, acc.data)));
            }),
        epoch: () => call(async () => BigInt((await conn.getEpochInfo('confirmed')).epoch)),
        rentExempt: (space) =>
            call(async () => BigInt(await conn.getMinimumBalanceForRentExemption(space, 'confirmed'))),
        minimumDelegation: () =>
            call(async () => BigInt((await conn.getStakeMinimumDelegation({ commitment: 'confirmed' })).value)),
    };
}
