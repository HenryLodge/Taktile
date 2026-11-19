import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PublicKey } from '@solana/web3.js';

import type { AppContact } from './contacts.ts';
import { base58 } from './proto/base58.ts';
import { activity, balance, describeTx, roundAmount, stakeAddresses, staked, stakeStatus } from './queries.ts';
import { RpcError, type Rpc, type SigInfo, type StakeInfo, type TxInfo } from './rpc.ts';
import { DEVNET_USDC_MINT, usdcAta } from './tx.ts';

const DEVICE = new PublicKey(new Uint8Array(32).fill(7)).toBytes();
const WALLET = base58(DEVICE);
const HENRY: AppContact = { name: 'Henry', address: new PublicKey(new Uint8Array(32).fill(3)).toBase58() };
const STRANGER = new PublicKey(new Uint8Array(32).fill(5)).toBase58();
const MINT = DEVNET_USDC_MINT.toBase58();
const SYSTEM = '11111111111111111111111111111111';
const SOL = 1_000_000_000n;
const USDC = 1_000_000n;
const NOW = 1_800_000_000;

function rpc(over: Partial<Rpc> = {}): Rpc {
    const no = async (): Promise<never> => {
        throw new Error('not used');
    };
    return {
        balance: async () => 1_250_000_000n,
        tokenBalance: async () => 10n * USDC,
        latestBlockhash: no,
        blockHeight: no,
        sendRaw: no,
        signatureStatus: no,
        signaturesFor: async () => [],
        transactions: async () => [],
        stakeAccounts: async (a) => a.map(() => null),
        epoch: async () => 100n,
        ...over,
    };
}
const deps = (r: Rpc) => ({ rpc: r, pubkey: DEVICE, contacts: [HENRY], now: () => NOW });

test('roundAmount: 2 decimals, trailing zeros dropped, tiny amounts said as such', () => {
    assert.equal(roundAmount(1_250_000_000n, 'SOL'), '1.25');
    assert.equal(roundAmount(1_255_000_000n, 'SOL'), '1.26');
    assert.equal(roundAmount(10n * USDC, 'USDC'), '10');
    assert.equal(roundAmount(1_500_000n, 'USDC'), '1.5');
    assert.equal(roundAmount(0n, 'SOL'), '0');
    assert.equal(roundAmount(5000n, 'SOL'), 'less than 0.01');
});

test('balance: both tokens, one token, no USDC account', async () => {
    assert.deepEqual(await balance(deps(rpc()), null), ['You have 1.25 SOL and 10 USDC.']);
    assert.deepEqual(await balance(deps(rpc()), 'SOL'), ['You have 1.25 SOL.']);
    assert.deepEqual(await balance(deps(rpc({ tokenBalance: async () => null })), 'USDC'), ['You have 0 USDC.']);
});

test('balance: the USDC account asked about is the device wallet ATA', async () => {
    let asked = '';
    await balance(deps(rpc({ tokenBalance: async (a) => ((asked = base58(a)), 0n) })), 'USDC');
    assert.equal(asked, base58(usdcAta(DEVICE)));
});

test('an RPC error becomes one friendly line', async () => {
    const r = rpc({
        balance: async () => {
            throw new RpcError('Devnet is rate-limiting. Try again in a few seconds.');
        },
    });
    assert.deepEqual(await balance(deps(r), null), ['Devnet is rate-limiting. Try again in a few seconds.']);
    const r2 = rpc({
        epoch: async () => {
            throw new Error('boom');
        },
        stakeAccounts: async (a) => a.map(() => ({ lamports: SOL, activationEpoch: 1n, deactivationEpoch: null })),
    });
    assert.deepEqual(await staked(deps(r2)), ['Devnet error: boom']);
});

test('stake addresses: 16 createWithSeed accounts, tk-stake-0 first', async () => {
    const a = await stakeAddresses(DEVICE);
    assert.equal(a.length, 16);
    assert.equal(new Set(a.map(base58)).size, 16);
    const first = await PublicKey.createWithSeed(
        new PublicKey(DEVICE),
        'tk-stake-0',
        new PublicKey('Stake11111111111111111111111111111111111111'),
    );
    assert.equal(base58(a[0] ?? new Uint8Array()), first.toBase58());
});

test('stakeStatus by epoch', () => {
    const s = (activationEpoch: bigint | null, deactivationEpoch: bigint | null): StakeInfo => ({
        lamports: SOL,
        activationEpoch,
        deactivationEpoch,
    });
    assert.equal(stakeStatus(s(100n, null), 100n), 'activating');
    assert.equal(stakeStatus(s(99n, null), 100n), 'active');
    assert.equal(stakeStatus(s(90n, 100n), 100n), 'deactivating');
    assert.equal(stakeStatus(s(90n, 99n), 100n), 'inactive');
    assert.equal(stakeStatus(s(null, null), 100n), 'not delegated');
});

test('staked: nothing, one active, mixed', async () => {
    assert.deepEqual(await staked(deps(rpc())), ['Nothing staked.']);
    const one = rpc({
        stakeAccounts: async (a) =>
            a.map((_, i) => (i === 0 ? { lamports: 2n * SOL, activationEpoch: 90n, deactivationEpoch: null } : null)),
    });
    assert.deepEqual(await staked(deps(one)), ['You have 2 SOL staked in 1 stake account. It is active.']);
    const mixed = rpc({
        stakeAccounts: async (a) =>
            a.map((_, i) =>
                i === 0
                    ? { lamports: 2n * SOL, activationEpoch: 90n, deactivationEpoch: null }
                    : i === 3
                      ? { lamports: SOL, activationEpoch: 100n, deactivationEpoch: null }
                      : null,
            ),
    });
    assert.deepEqual(await staked(deps(mixed)), [
        'You have 3 SOL staked in 2 stake accounts: 2 SOL active, 1 SOL activating.',
    ]);
});

const solOut: TxInfo = {
    signature: 'a',
    slot: 30,
    blockTime: NOW - 300,
    failed: false,
    fee: 5000n,
    accounts: [WALLET, HENRY.address, SYSTEM],
    preLamports: [2n * SOL, 0n, 1n],
    postLamports: [2n * SOL - SOL / 100n - 5000n, SOL / 100n, 1n],
    tokens: [],
};
const usdcIn: TxInfo = {
    signature: 'b',
    slot: 20,
    blockTime: NOW - 7200,
    failed: false,
    fee: 5000n,
    accounts: [STRANGER, 'srcAta', base58(usdcAta(DEVICE))],
    preLamports: [SOL, 0n, 0n],
    postLamports: [SOL - 5000n, 0n, 0n],
    tokens: [
        { owner: STRANGER, mint: MINT, pre: 10n * USDC, post: 5n * USDC },
        { owner: WALLET, mint: MINT, pre: 0n, post: 5n * USDC },
    ],
};

test('describeTx: SOL out to a contact (fee not counted), USDC in from an unknown address', () => {
    assert.equal(describeTx(solOut, WALLET, [HENRY], NOW), 'Sent 0.01 SOL to Henry, 5 minutes ago.');
    assert.equal(describeTx(usdcIn, WALLET, [HENRY], NOW), 'Received 5 USDC from an unknown address, 2 hours ago.');
    assert.equal(describeTx({ ...solOut, failed: true }, WALLET, [HENRY], NOW), 'A failed transaction, 5 minutes ago.');
    assert.equal(
        describeTx({ ...solOut, blockTime: null, postLamports: [2n * SOL - 5000n, 0n, 1n] }, WALLET, [HENRY], NOW),
        'A transaction with no balance change.',
    );
});

test('activity: wallet and USDC account merged, newest first, at most 3', async () => {
    const asked: string[] = [];
    const sigs = new Map<string, SigInfo[]>([
        [
            WALLET,
            [
                { signature: 'a', slot: 30 },
                { signature: 'c', slot: 10 },
            ],
        ],
        [
            base58(usdcAta(DEVICE)),
            [
                { signature: 'b', slot: 20 },
                { signature: 'c', slot: 10 },
                { signature: 'd', slot: 5 },
            ],
        ],
    ]);
    const r = rpc({
        signaturesFor: async (addr) => sigs.get(base58(addr)) ?? [],
        transactions: async (s) => {
            asked.push(...s);
            return s.map((x) => (x === 'a' ? solOut : x === 'b' ? usdcIn : null));
        },
    });
    const lines = await activity(deps(r));
    assert.deepEqual(asked, ['a', 'b', 'c']);
    assert.deepEqual(lines, [
        'Your last 3 transactions:',
        'Sent 0.01 SOL to Henry, 5 minutes ago.',
        'Received 5 USDC from an unknown address, 2 hours ago.',
        'A transaction devnet has not returned yet.',
    ]);
});

test('activity: none yet', async () => {
    assert.deepEqual(await activity(deps(rpc())), ['No transactions yet.']);
});

test('every spoken line fits the app voice limit', async () => {
    const { HELP_LINES } = await import('./queries.ts');
    const { MAX_TTS_CHARS } = await import('./speech.ts');
    for (const l of HELP_LINES) {
        assert.ok(l.length <= MAX_TTS_CHARS, l);
    }
});
