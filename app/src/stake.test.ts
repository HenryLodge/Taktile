import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { PublicKey } from '@solana/web3.js';

import { base58 } from './proto/base58.ts';
import { DeviceClient } from './proto/client.ts';
import { EVENT, MSG, STATUS } from './proto/codes.ts';
import type { Frame } from './proto/frame.ts';
import type { Rpc, StakeInfo } from './rpc.ts';
import type { Report } from './send.ts';
import { freeIndex, listStakeAccounts, parseAccountChoice, runStake, runUnstake, unstakeable } from './stake.ts';
import { MockTransport, reply, type MockStep } from './transport/mock.ts';
import { stakeMessage, unstakeMessage } from './tx.ts';
import { VALIDATOR } from './validator.ts';

const R = 0x80;
const SOL = 1_000_000_000n;
const RENT = 1_666_240n;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const DEVICE = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

const active: StakeInfo = { lamports: 2n * SOL, activationEpoch: 90n, deactivationEpoch: null };
const deactivating: StakeInfo = { lamports: 2n * SOL, activationEpoch: 90n, deactivationEpoch: 100n };

function fakeRpc(o: { accounts?: (StakeInfo | null)[]; balance?: bigint } = {}): Rpc {
    const no = async (): Promise<never> => {
        throw new Error('not used');
    };
    return {
        balance: async () => o.balance ?? 10n * SOL,
        tokenBalance: no,
        latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }),
        blockHeight: async () => 990,
        sendRaw: async (tx) => base58(tx.subarray(1, 65)), // devnet answers with the signature
        signatureStatus: async () => ({ state: 'confirmed' }),
        signaturesFor: async () => [],
        transactions: async () => [],
        stakeAccounts: async (a) => a.map((_, i) => o.accounts?.[i] ?? null),
        epoch: async () => 100n,
        rentExempt: async () => RENT,
        minimumDelegation: async () => SOL,
    };
}

const hello = (state: number): MockStep => ({
    expect: { type: MSG.HELLO },
    reply: (q) => [reply(MSG.HELLO | R, [1, 0, 1, state])(q)],
});
function signs(seen: Uint8Array[]): MockStep {
    return {
        expect: { type: MSG.SIGN_REQUEST },
        reply: (q: Frame) => {
            seen.push(q.payload);
            const sig = new Uint8Array(sign(null, q.payload, privateKey));
            return [reply(MSG.EVENT, [EVENT.ANNOUNCING])(q), reply(MSG.SIGN_REQUEST | R, [STATUS.OK, ...sig])(q)];
        },
    };
}

function deps(steps: MockStep[], rpc: Rpc) {
    const client = new DeviceClient(new MockTransport(steps));
    const reports: Report[] = [];
    return {
        reports,
        d: {
            client,
            pubkey: DEVICE,
            rpc,
            unlock: () => client.unlock(),
            report: (r: Report): void => void reports.push(r),
            sleep: async () => undefined,
        },
    };
}

test('freeIndex: the lowest index without an account; null when all 16 exist', () => {
    assert.equal(freeIndex([]), 0);
    const acc = (index: number) => ({ index, address: '', lamports: 0n, status: 'active' as const });
    assert.equal(freeIndex([acc(0), acc(1), acc(3)]), 2);
    assert.equal(freeIndex(Array.from({ length: 16 }, (_, i) => acc(i))), null);
});

test('listStakeAccounts and unstakeable: only active or activating accounts can be unstaked', async () => {
    const list = await listStakeAccounts(fakeRpc({ accounts: [active, null, deactivating] }), DEVICE);
    assert.deepEqual(
        list.map((a) => [a.index, a.status]),
        [
            [0, 'active'],
            [2, 'deactivating'],
        ],
    );
    assert.deepEqual(
        unstakeable(list).map((a) => a.index),
        [0],
    );
});

test('stake 2 SOL: the lowest free account, 2 SOL + rent, the pinned validator, signed on the device', async () => {
    const seen: Uint8Array[] = [];
    const { d, reports } = deps([hello(2), signs(seen)], fakeRpc({ accounts: [active] }));
    const out = await runStake(2n * SOL, d);
    assert.equal(out.ok, true, JSON.stringify(reports.at(-1)));
    assert.equal(seen.length, 1);
    const want = await stakeMessage(DEVICE, 1, 2n * SOL + RENT, VALIDATOR.voteAccount, BLOCKHASH);
    assert.deepEqual(seen[0], want);
    const ck = reports.find((r) => r.phase === 'checksum');
    assert.match(ck?.text ?? '', /^Staking 2\.00166624 SOL with Kiln, stake account 1\. Checksum: /);
    assert.match(reports.at(-1)?.text ?? '', /^Staked and confirmed/);
});

test('stake refusals before the device is asked: minimum, all accounts used, balance', async () => {
    const cases: [bigint, Rpc, RegExp][] = [
        [SOL / 2n, fakeRpc(), /smallest stake devnet accepts is 1 SOL/],
        [SOL, fakeRpc({ accounts: Array.from({ length: 16 }, () => active) }), /All 16 stake accounts/],
        [SOL, fakeRpc({ balance: SOL }), /Not enough SOL/],
    ];
    for (const [amount, rpc, why] of cases) {
        const t = new MockTransport([]);
        const client = new DeviceClient(t);
        const reports: Report[] = [];
        const out = await runStake(amount, {
            client,
            pubkey: DEVICE,
            rpc,
            unlock: () => client.unlock(),
            report: (r) => void reports.push(r),
        });
        assert.equal(out.ok, false);
        assert.match(reports.at(-1)?.text ?? '', why);
        assert.equal(t.written.length, 0, 'nothing reached the device');
    }
});

test('unstake: Shape D for that account, signed on the device', async () => {
    const seen: Uint8Array[] = [];
    const { d, reports } = deps([hello(1), unlockOk(), signs(seen)], fakeRpc());
    const out = await runUnstake(3, d);
    assert.equal(out.ok, true, JSON.stringify(reports.at(-1)));
    assert.deepEqual(seen[0], await unstakeMessage(DEVICE, 3, BLOCKHASH));
    assert.match(reports.find((r) => r.phase === 'checksum')?.text ?? '', /^Unstaking stake account 3\. Checksum: /);
});

function unlockOk(): MockStep {
    return {
        expect: { type: MSG.UNLOCK },
        reply: (q) => [reply(MSG.EVENT, [EVENT.AWAITING_PIN])(q), reply(MSG.UNLOCK | R, [STATUS.OK])(q)],
    };
}

test('parseAccountChoice: digits, number words, all; anything else is no', () => {
    assert.equal(parseAccountChoice('2', [0, 2]), 2);
    assert.equal(parseAccountChoice('Stake account two.', [0, 2]), 2);
    assert.equal(parseAccountChoice('zero', [0, 2]), 0);
    assert.equal(parseAccountChoice('both of them', [0, 2]), 'all');
    assert.equal(parseAccountChoice('all', [0, 2]), 'all');
    assert.equal(parseAccountChoice('five', [0, 2]), null); // not one of the choices
    assert.equal(parseAccountChoice('cancel', [0, 2]), null);
    assert.equal(parseAccountChoice('hmm', [0, 2]), null);
    assert.equal(parseAccountChoice('fifteen', [15]), 15);
});
