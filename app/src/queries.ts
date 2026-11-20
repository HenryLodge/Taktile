// Read-only voice queries (docs/EXTRATASKS.md Part 1 V2): balance, staked, recent activity, help.
//
// Source: the laptop (devnet RPC and the app's own contacts). These answers are information only and
// never an input to signing; the device does not see them and does not vouch for them
// (SECURITY_MODEL.md "Command sources"). Each answer is a list of short lines: the app voice speaks at
// most MAX_TTS_CHARS per line (src/speech.ts).

import { PublicKey, StakeProgram } from '@solana/web3.js';

import { DECIMALS, type Token } from './amount.ts';
import type { AppContact } from './contacts.ts';
import { base58 } from './proto/base58.ts';
import { RpcError, type Rpc, type StakeInfo, type TxInfo } from './rpc.ts';
import { DEVNET_USDC_MINT, usdcAta } from './tx.ts';

export interface QueryDeps {
    rpc: Rpc;
    /** The device wallet's public key. */
    pubkey: Uint8Array;
    contacts: readonly AppContact[];
    /** Unix seconds; injectable for tests. */
    now?: () => number;
}

/** Stake accounts are `tk-stake-0` .. `tk-stake-15`, derived from the device wallet (Part 3). */
export const STAKE_SEEDS = 16;
export const stakeSeed = (n: number): string => `tk-stake-${n}`;

export async function stakeAddresses(wallet: Uint8Array): Promise<Uint8Array[]> {
    const base = new PublicKey(wallet);
    const out: Uint8Array[] = [];
    for (let n = 0; n < STAKE_SEEDS; n++) {
        out.push((await PublicKey.createWithSeed(base, stakeSeed(n), StakeProgram.programId)).toBytes());
    }
    return out;
}

/** Base units -> text rounded to 2 decimals, trailing zeros dropped: "1.25", "10", "less than 0.01". */
export function roundAmount(units: bigint, token: Token): string {
    const scale = 10n ** BigInt(DECIMALS[token] - 2);
    const neg = units < 0n;
    const abs = neg ? -units : units;
    const cents = (abs + scale / 2n) / scale;
    if (cents === 0n && abs > 0n) {
        return 'less than 0.01';
    }
    const whole = cents / 100n;
    const frac = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

const amountText = (units: bigint, token: Token): string => `${roundAmount(units, token)} ${token}`;

/** RPC failures become one friendly line instead of an exception. */
async function answer(fn: () => Promise<string[]>): Promise<string[]> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof RpcError) {
            return [e.message];
        }
        return [`Devnet error: ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}`];
    }
}

export function balance(d: QueryDeps, token: Token | null): Promise<string[]> {
    return answer(async () => {
        const sol = token === 'USDC' ? null : await d.rpc.balance(d.pubkey);
        const usdc = token === 'SOL' ? null : ((await d.rpc.tokenBalance(usdcAta(d.pubkey))) ?? 0n);
        const parts = [
            ...(sol === null ? [] : [amountText(sol, 'SOL')]),
            ...(usdc === null ? [] : [amountText(usdc, 'USDC')]),
        ];
        return [`You have ${parts.join(' and ')}.`];
    });
}

export type StakeStatus = 'activating' | 'active' | 'deactivating' | 'inactive' | 'not delegated';

/** Without the warm-up/cool-down rate limits (one validator on devnet: close enough to say out loud). */
export function stakeStatus(s: StakeInfo, epoch: bigint): StakeStatus {
    if (s.activationEpoch === null) {
        return 'not delegated';
    }
    if (s.deactivationEpoch === null) {
        return epoch > s.activationEpoch ? 'active' : 'activating';
    }
    return epoch > s.deactivationEpoch ? 'inactive' : 'deactivating';
}

const STATUS_WORDS: Record<StakeStatus, string> = {
    activating: 'activating',
    active: 'active',
    deactivating: 'deactivating',
    inactive: 'unstaked and ready to withdraw',
    'not delegated': 'not delegated',
};
const STATUS_ORDER: StakeStatus[] = ['active', 'activating', 'deactivating', 'inactive', 'not delegated'];

export function staked(d: QueryDeps): Promise<string[]> {
    return answer(async () => {
        const accounts = (await d.rpc.stakeAccounts(await stakeAddresses(d.pubkey))).filter(
            (a): a is StakeInfo => a !== null,
        );
        if (accounts.length === 0) {
            return ['Nothing staked.'];
        }
        const epoch = await d.rpc.epoch();
        const by = new Map<StakeStatus, bigint>();
        let total = 0n;
        for (const a of accounts) {
            const st = stakeStatus(a, epoch);
            by.set(st, (by.get(st) ?? 0n) + a.lamports);
            total += a.lamports;
        }
        const n = accounts.length;
        const where = `in ${n} stake account${n === 1 ? '' : 's'}`;
        if (by.size === 1) {
            const [st] = [...by.keys()];
            return [
                `You have ${amountText(total, 'SOL')} staked ${where}. ${n === 1 ? 'It is' : 'All are'} ${STATUS_WORDS[st ?? 'active']}.`,
            ];
        }
        const parts = STATUS_ORDER.filter((s) => by.has(s)).map(
            (s) => `${amountText(by.get(s) ?? 0n, 'SOL')} ${STATUS_WORDS[s]}`,
        );
        return [`You have ${amountText(total, 'SOL')} staked ${where}: ${parts.join(', ')}.`];
    });
}

function ago(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
    if (s < 60) {
        return 'just now';
    }
    if (s < 3600) {
        return unit(Math.floor(s / 60), 'minute');
    }
    if (s < 86_400) {
        return unit(Math.floor(s / 3600), 'hour');
    }
    return unit(Math.floor(s / 86_400), 'day');
}

/** One spoken line for a transaction, from the device wallet's point of view. */
export function describeTx(tx: TxInfo, wallet: string, contacts: readonly AppContact[], now: number): string {
    const when = tx.blockTime === null ? '' : `, ${ago(now - tx.blockTime)}`;
    if (tx.failed) {
        return `A failed transaction${when}.`;
    }
    const name = (addr: string | undefined): string =>
        contacts.find((c) => c.address === addr)?.name ?? 'an unknown address';
    const mint = DEVNET_USDC_MINT.toBase58();

    const mine = tx.tokens.find((t) => t.owner === wallet && t.mint === mint);
    const usdcDelta = mine === undefined ? 0n : mine.post - mine.pre;
    if (usdcDelta !== 0n) {
        const other = tx.tokens.find((t) => t.mint === mint && t.owner !== wallet && (t.post - t.pre) * usdcDelta < 0n);
        return usdcDelta < 0n
            ? `Sent ${amountText(-usdcDelta, 'USDC')} to ${name(other?.owner)}${when}.`
            : `Received ${amountText(usdcDelta, 'USDC')} from ${name(other?.owner)}${when}.`;
    }

    const i = tx.accounts.indexOf(wallet);
    if (i >= 0) {
        const fee = i === 0 ? tx.fee : 0n; // the fee payer is account 0
        const delta = (tx.postLamports[i] ?? 0n) - (tx.preLamports[i] ?? 0n) + fee;
        if (delta !== 0n) {
            let other: string | undefined;
            let best = 0n;
            tx.accounts.forEach((a, k) => {
                const dk = (tx.postLamports[k] ?? 0n) - (tx.preLamports[k] ?? 0n);
                const mag = dk < 0n ? -dk : dk;
                if (k !== i && dk * delta < 0n && mag > best) {
                    best = mag;
                    other = a;
                }
            });
            return delta < 0n
                ? `Sent ${amountText(-delta, 'SOL')} to ${name(other)}${when}.`
                : `Received ${amountText(delta, 'SOL')} from ${name(other)}${when}.`;
        }
    }
    return `A transaction with no balance change${when}.`;
}

export function activity(d: QueryDeps, count = 3): Promise<string[]> {
    return answer(async () => {
        // Incoming USDC touches only the token account, not the wallet, so ask about both.
        const [a, b] = await Promise.all([
            d.rpc.signaturesFor(d.pubkey, count),
            d.rpc.signaturesFor(usdcAta(d.pubkey), count),
        ]);
        const seen = new Set<string>();
        const sigs = [...a, ...b]
            .filter((s) => !seen.has(s.signature) && seen.add(s.signature))
            .sort((x, y) => y.slot - x.slot)
            .slice(0, count)
            .map((s) => s.signature);
        if (sigs.length === 0) {
            return ['No transactions yet.'];
        }
        const txs = await d.rpc.transactions(sigs);
        const now = (d.now ?? (() => Date.now() / 1000))();
        const wallet = base58(d.pubkey);
        const lines = txs.map((t) =>
            t === null ? 'A transaction devnet has not returned yet.' : describeTx(t, wallet, d.contacts, now),
        );
        const head = lines.length === 1 ? 'Your last transaction:' : `Your last ${lines.length} transactions:`;
        return [head, ...lines];
    });
}

/** About 15 s of speech. Each line stays under the app voice's per-line limit. */
export const HELP_LINES = [
    'You can say: send 5 USDC to Henry. What is my balance. How much do I have staked. What was my last transaction.',
    'Stake 1 SOL. Unstake. Request 5 USDC from Henry. What is my address. Who are my contacts. Lock my wallet. Repeat that. Cancel.',
];
