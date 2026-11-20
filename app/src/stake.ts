// Staking from the app (docs/EXTRATASKS.md Part 3 S4): "stake 2 SOL", "unstake", "unstake all".
//
// The app builds Shape C or D (docs/SOLANA.md) for one of the device's own derived stake accounts
// (tk-stake-0 .. tk-stake-15) and the pinned validator, then runs the same signing steps as a send
// (src/send.ts signAndBroadcast): PIN, fresh blockhash, app checksum, the device's announcement
// ("stake ... with Kiln, stake account n"), CONFIRM, verify, broadcast. The device re-checks
// everything itself; this module only decides which account to use.

import { DECIMALS, formatAmount } from './amount.ts';
import { stakeAddresses, stakeStatus, type StakeStatus } from './queries.ts';
import { base58 } from './proto/base58.ts';
import type { Rpc } from './rpc.ts';
import { signAndBroadcast, type SendDeps, type SendOutcome } from './send.ts';
import { FEE_LAMPORTS, STAKE_SEEDS, STAKE_SPACE, stakeMessage, unstakeMessage } from './tx.ts';
import { VALIDATOR } from './validator.ts';

export interface StakeAccountState {
    index: number;
    address: string;
    lamports: bigint;
    status: StakeStatus;
}

const sol = (lamports: bigint) => `${formatAmount(lamports, DECIMALS.SOL)} SOL`;

/** The device's stake accounts that exist, by index. */
export async function listStakeAccounts(rpc: Rpc, device: Uint8Array): Promise<StakeAccountState[]> {
    const addrs = await stakeAddresses(device);
    const infos = await rpc.stakeAccounts(addrs);
    const out: StakeAccountState[] = [];
    let epoch: bigint | null = null;
    for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        const addr = addrs[i];
        if (info === null || info === undefined || addr === undefined) {
            continue;
        }
        epoch ??= await rpc.epoch();
        out.push({ index: i, address: base58(addr), lamports: info.lamports, status: stakeStatus(info, epoch) });
    }
    return out;
}

/** The lowest index with no account yet, or null when all 16 exist. */
export function freeIndex(accounts: readonly StakeAccountState[]): number | null {
    const used = new Set(accounts.map((a) => a.index));
    for (let i = 0; i < STAKE_SEEDS; i++) {
        if (!used.has(i)) {
            return i;
        }
    }
    return null;
}

/** Accounts "unstake" can act on: delegated and not already on the way out. */
export const unstakeable = (accounts: readonly StakeAccountState[]): StakeAccountState[] =>
    accounts.filter((a) => a.status === 'active' || a.status === 'activating');

const failed = (d: SendDeps, text: string): SendOutcome => {
    void d.report({ phase: 'failed', text, level: 'alert' });
    return { ok: false, reason: text };
};

/**
 * "stake N SOL": a new stake account (the lowest free index), funded with N plus the rent-exempt
 * reserve, delegated to the pinned validator.
 */
export async function runStake(amount: bigint, d: SendDeps): Promise<SendOutcome> {
    if (d.client.flowRunning) {
        return failed(d, 'Wait for the current request on the device to finish.');
    }
    let index: number | null;
    let lamports: bigint;
    try {
        void d.report({
            phase: 'checking',
            text: 'Checking your stake accounts and balance on devnet.',
            level: 'info',
        });
        const min = await d.rpc.minimumDelegation();
        if (amount < min) {
            return failed(d, `The smallest stake devnet accepts is ${sol(min)}.`);
        }
        index = freeIndex(await listStakeAccounts(d.rpc, d.pubkey));
        if (index === null) {
            return failed(
                d,
                'All 16 stake accounts are in use. An unstaked account has to be withdrawn before it can be reused, and this version cannot withdraw yet.',
            );
        }
        const rent = await d.rpc.rentExempt(STAKE_SPACE);
        lamports = amount + rent;
        const have = await d.rpc.balance(d.pubkey);
        if (have < lamports + FEE_LAMPORTS) {
            return failed(
                d,
                `Not enough SOL on the device: it has ${sol(have)}, this stake needs ${sol(lamports + FEE_LAMPORTS)} (including a ${sol(rent)} reserve that stays in the stake account).`,
            );
        }
    } catch (e) {
        return failed(d, `Staking failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const n = index;
    return signAndBroadcast(
        (blockhash) => stakeMessage(d.pubkey, n, lamports, VALIDATOR.voteAccount, blockhash),
        { what: `${sol(lamports)} with ${VALIDATOR.name}, stake account ${n}`, doing: 'Staking', done: 'Staked' },
        d,
    );
}

/** "unstake": deactivate stake account n. The SOL stays in it until a later withdrawal. */
export async function runUnstake(index: number, d: SendDeps): Promise<SendOutcome> {
    if (d.client.flowRunning) {
        return failed(d, 'Wait for the current request on the device to finish.');
    }
    return signAndBroadcast(
        (blockhash) => unstakeMessage(d.pubkey, index, blockhash),
        { what: `stake account ${index}`, doing: 'Unstaking', done: 'Unstaked' },
        d,
    );
}

const NUMBER_WORDS = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
]; // prettier-ignore

/** An answer to "Which stake account: 0 or 2?": an index from `choices`, 'all', or null. */
export function parseAccountChoice(text: string, choices: readonly number[]): number | 'all' | null {
    const t = text.toLowerCase();
    if (/\b(all|both|every|everything)\b/.test(t)) {
        return 'all';
    }
    if (/\b(cancel|stop|none|neither|never ?mind|no)\b/.test(t)) {
        return null;
    }
    const digit = /\b(\d{1,2})\b/.exec(t);
    let n: number | null = digit?.[1] !== undefined ? Number(digit[1]) : null;
    if (n === null) {
        const word = NUMBER_WORDS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
        n = word >= 0 ? word : null;
    }
    return n !== null && choices.includes(n) ? n : null;
}
