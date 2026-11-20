import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { PublicKey } from '@solana/web3.js';

import type { SendIntent, Report } from './send.ts';
import { runSend } from './send.ts';
import { DeviceClient } from './proto/client.ts';
import { EVENT, MSG, STATUS } from './proto/codes.ts';
import { base58 } from './proto/base58.ts';
import type { Rpc, SigStatus } from './rpc.ts';
import { MockTransport, reply, type MockStep } from './transport/mock.ts';
import type { Frame } from './proto/frame.ts';
import { DEVNET_USDC_MINT, TOKEN_PROGRAM, usdcAta } from './tx.ts';

const R = 0x80;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const DEVICE = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const HENRY = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const HENRY_BYTES = new PublicKey(HENRY).toBytes();
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

const intent = (over: Partial<SendIntent> = {}): SendIntent => ({
    kind: 'send',
    token: 'SOL',
    amount: 10_000_000n,
    amountText: '0.01',
    contact: { name: 'Henry', address: HENRY },
    ...over,
});

function fakeRpc(
    trace: string[],
    over: Partial<{ balance: bigint; height: number; statuses: SigStatus[]; tokens: Map<string, bigint> }> = {},
) {
    const statuses = [...(over.statuses ?? [{ state: 'pending' }, { state: 'confirmed' }])];
    const sent: Uint8Array[] = [];
    const rpc: Rpc = {
        balance: async () => (trace.push('rpc:balance'), over.balance ?? 1_000_000_000n),
        tokenBalance: async (ata) => {
            trace.push('rpc:token');
            const tokens =
                over.tokens ??
                new Map([
                    [base58(usdcAta(DEVICE)), 20_000_000n],
                    [base58(usdcAta(HENRY_BYTES)), 0n],
                ]);
            return tokens.get(base58(ata)) ?? null;
        },
        latestBlockhash: async () => (
            trace.push('rpc:blockhash'), { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }
        ),
        blockHeight: async () => (trace.push('rpc:height'), over.height ?? 990),
        sendRaw: async (tx) => {
            trace.push('rpc:send');
            sent.push(tx);
            return base58(tx.subarray(1, 65));
        },
        signatureStatus: async () => (trace.push('rpc:status'), statuses.shift() ?? { state: 'pending' }),
        signaturesFor: async () => [],
        transactions: async () => [],
        stakeAccounts: async (a) => a.map(() => null),
        epoch: async () => 0n,
        rentExempt: async () => 1_666_240n,
        minimumDelegation: async () => 1_000_000_000n,
    };
    return { rpc, sent };
}

const hello = (state: number): MockStep => ({
    expect: { type: MSG.HELLO },
    reply: (q) => [reply(MSG.HELLO | R, [1, 0, 1, state])(q)],
});
const unlockOk = (status: number = STATUS.OK): MockStep => ({
    expect: { type: MSG.UNLOCK },
    reply: (q) => [reply(MSG.EVENT, [EVENT.AWAITING_PIN])(q), reply(MSG.UNLOCK | R, [status])(q)],
});
const signs = (forge = false): MockStep => ({
    expect: { type: MSG.SIGN_REQUEST },
    reply: (q: Frame) => {
        const sig = new Uint8Array(sign(null, q.payload, privateKey));
        if (forge) {
            sig[0] = (sig[0] ?? 0) ^ 0xff;
        }
        return [
            reply(MSG.EVENT, [EVENT.ANNOUNCING])(q),
            reply(MSG.EVENT, [EVENT.AWAITING_CONFIRM])(q),
            reply(MSG.EVENT, [EVENT.SIGNING])(q),
            reply(MSG.SIGN_REQUEST | R, [STATUS.OK, ...sig])(q),
        ];
    },
});
const refuses = (status: number): MockStep => ({
    expect: { type: MSG.SIGN_REQUEST },
    reply: (q) => [reply(MSG.EVENT, [EVENT.ANNOUNCING])(q), reply(MSG.SIGN_REQUEST | R, [status])(q)],
});

function harness(steps: MockStep[], rpcOver = {}) {
    const trace: string[] = [];
    const t = new MockTransport(steps);
    const origWrite = t.write.bind(t);
    t.write = async (b: Uint8Array) => {
        trace.push(`dev:0x${(b[2] ?? 0).toString(16)}`);
        return origWrite(b);
    };
    const client = new DeviceClient(t);
    const { rpc, sent } = fakeRpc(trace, rpcOver);
    const reports: Report[] = [];
    const deps = {
        client,
        pubkey: DEVICE,
        rpc,
        unlock: () => client.unlock(),
        report: (r: Report): void | Promise<void> => void reports.push(r),
        sleep: async () => undefined,
    };
    return { t, trace, sent, reports, deps };
}

test('locked: balance, HELLO, UNLOCK, then a fresh blockhash, sign, verify, broadcast, confirm', async () => {
    const h = harness([hello(1), unlockOk(), signs()]);
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, true, JSON.stringify(h.reports));
    assert.deepEqual(h.trace, [
        'rpc:balance',
        'dev:0x1',
        'dev:0x4',
        'rpc:blockhash', // only after the PIN
        'dev:0x10',
        'rpc:height',
        'rpc:send',
        'rpc:status',
        'rpc:status',
    ]);
    assert.deepEqual(h.t.errors, []);
    assert.equal(h.sent.length, 1);
    // what was broadcast is 0x01 || signature || exactly the bytes the device signed
    const signed = h.t.written.find((f) => f.type === MSG.SIGN_REQUEST);
    assert.ok(signed);
    assert.deepEqual(h.sent[0]?.subarray(65), signed.payload);
    if (out.ok) {
        assert.equal(out.confirmed, true);
        assert.match(out.explorer, /^https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]+\?cluster=devnet$/);
        assert.equal(out.appPhrase.length, 3);
    }
    assert.ok(
        h.reports.some((r) => r.phase === 'checksum' && r.text.includes(out.ok ? out.appPhrase.join(', ') : '?')),
    );
    assert.ok(h.reports.some((r) => r.text === 'Press Confirm or Reject on the device.'));
});

test('already unlocked: no UNLOCK', async () => {
    const h = harness([hello(2), signs()]);
    assert.equal((await runSend(intent(), h.deps)).ok, true);
    assert.ok(!h.trace.includes('dev:0x4'));
});

for (const [name, status] of [
    ['UNKNOWN_RECIPIENT', STATUS.UNKNOWN_RECIPIENT],
    ['REJECTED_BY_USER', STATUS.REJECTED_BY_USER],
    ['PARSE_UNSUPPORTED', STATUS.PARSE_UNSUPPORTED],
    ['CANCELLED', STATUS.CANCELLED],
] as const) {
    test(`device says ${name}: nothing broadcast`, async () => {
        const h = harness([hello(2), refuses(status)]);
        const out = await runSend(intent(), h.deps);
        assert.equal(out.ok, false);
        assert.equal(h.sent.length, 0);
        assert.ok(!h.trace.includes('rpc:send'));
        if (status === STATUS.UNKNOWN_RECIPIENT) {
            assert.equal(h.reports.at(-1)?.level, 'alert');
            assert.match(h.reports.at(-1)?.text ?? '', /unknown recipient/);
        }
    });
}

test('UNLOCK not OK: stops before the blockhash', async () => {
    const h = harness([hello(1), unlockOk(STATUS.REJECTED_BY_USER)]);
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, false);
    assert.ok(!h.trace.includes('rpc:blockhash'));
    assert.ok(!h.trace.includes('dev:0x10'));
});

test('a signature that does not verify is never broadcast', async () => {
    const h = harness([hello(2), signs(true)]);
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, false);
    assert.match(out.ok ? '' : out.reason, /did not verify/);
    assert.equal(h.sent.length, 0);
});

test('expired blockhash: nothing broadcast', async () => {
    const h = harness([hello(2), signs()], { height: 1001 });
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, false);
    assert.match(out.ok ? '' : out.reason, /expired/);
    assert.equal(h.sent.length, 0);
});

test('not enough SOL: no device traffic at all', async () => {
    const h = harness([], { balance: 10_000_000n + 4_999n });
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, false);
    assert.match(out.ok ? '' : out.reason, /Not enough SOL/);
    assert.deepEqual(h.trace, ['rpc:balance']);
});

test('exactly enough SOL (amount + fee) is allowed', async () => {
    const h = harness([hello(2), signs()], { balance: 10_000_000n + 5_000n });
    assert.equal((await runSend(intent(), h.deps)).ok, true);
});

const usdc1 = (over: Partial<SendIntent> = {}) =>
    intent({ token: 'USDC', amount: 1_000_000n, amountText: '1', ...over });

test("USDC: checks both token accounts, then UNLOCK, blockhash, TransferChecked to Henry's ATA", async () => {
    const h = harness([hello(1), unlockOk(), signs()]);
    const out = await runSend(usdc1(), h.deps);
    assert.equal(out.ok, true, JSON.stringify(h.reports.map((r) => r.text)));
    assert.deepEqual(h.trace.slice(0, 6), [
        'rpc:balance',
        'rpc:token',
        'rpc:token',
        'dev:0x1',
        'dev:0x4',
        'rpc:blockhash',
    ]);
    const msg = h.t.written.find((f) => f.type === MSG.SIGN_REQUEST)?.payload;
    assert.ok(msg);
    const keys = Array.from({ length: msg[3] ?? 0 }, (_, i) => base58(msg.subarray(4 + 32 * i, 36 + 32 * i)));
    assert.equal(keys[0], base58(DEVICE)); // fee payer (I5)
    for (const k of [
        base58(usdcAta(DEVICE)),
        base58(usdcAta(HENRY_BYTES)),
        DEVNET_USDC_MINT.toBase58(),
        TOKEN_PROGRAM.toBase58(),
    ]) {
        assert.ok(keys.includes(k), k);
    }
    assert.ok(!keys.includes(HENRY), 'USDC goes to the token account, not the wallet');
    assert.equal(h.sent.length, 1);
});

test('USDC: not enough on the device: no device traffic', async () => {
    const h = harness([], {
        tokens: new Map([
            [base58(usdcAta(DEVICE)), 999_999n],
            [base58(usdcAta(HENRY_BYTES)), 0n],
        ]),
    });
    const out = await runSend(usdc1(), h.deps);
    assert.match(out.ok ? '' : out.reason, /Not enough USDC on the device: it has 0.999999 USDC/);
    assert.ok(!h.trace.some((t) => t.startsWith('dev:')));
});

test('USDC: the device has no USDC account', async () => {
    const h = harness([], { tokens: new Map() });
    const out = await runSend(usdc1(), h.deps);
    assert.match(out.ok ? '' : out.reason, /no USDC account yet/);
    assert.ok(!h.trace.some((t) => t.startsWith('dev:')));
});

test("USDC: Henry's token account missing: refused before the device", async () => {
    const h = harness([], { tokens: new Map([[base58(usdcAta(DEVICE)), 20_000_000n]]) });
    const out = await runSend(usdc1(), h.deps);
    assert.match(out.ok ? '' : out.reason, /Henry has no USDC account yet/);
    assert.ok(!h.trace.some((t) => t.startsWith('dev:')));
});

test('USDC: only the fee is needed in SOL', async () => {
    const h = harness([hello(2), signs()], { balance: 5_000n });
    assert.equal((await runSend(usdc1(), h.deps)).ok, true);
});

test('USDC: the device refuses an unknown recipient: nothing broadcast', async () => {
    const h = harness([hello(2), refuses(STATUS.UNKNOWN_RECIPIENT)]);
    const out = await runSend(usdc1(), h.deps);
    assert.equal(out.ok, false);
    assert.equal(h.sent.length, 0);
});

test('sending to the device itself is refused before anything', async () => {
    const h = harness([]);
    const out = await runSend(intent({ contact: { name: 'Me', address: base58(DEVICE) } }), h.deps);
    assert.equal(out.ok, false);
    assert.deepEqual(h.trace, []);
});

test('not confirmed in time: still reported as sent, with the link', async () => {
    const h = harness([hello(2), signs()], { statuses: [] });
    h.deps.sleep = async () => undefined;
    const out = await runSend(intent(), { ...h.deps, confirmTimeoutMs: 3000, pollMs: 1000 });
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.confirmed, false);
    assert.match(h.reports.at(-1)?.text ?? '', /not confirmed yet/);
});

test('devnet reports the transaction failed', async () => {
    const h = harness([hello(2), signs()], {
        statuses: [{ state: 'failed', error: '{"InsufficientFundsForRent":{}}' }],
    });
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, false);
    assert.match(out.ok ? '' : out.reason, /rejected the transaction/);
});

test('an RPC error after broadcast never says nothing was sent', async () => {
    const h = harness([hello(2), signs()]);
    h.deps.rpc.signatureStatus = async () => {
        throw new Error('network down');
    };
    const out = await runSend(intent(), h.deps);
    assert.equal(out.ok, true);
    assert.match(h.reports.at(-1)?.text ?? '', /^Sent, but/);
});

test('the checksum line is spoken, and finishes, before SIGN_REQUEST', async () => {
    const h = harness([hello(2), signs()]);
    let spokenAt = -1;
    const report = h.deps.report;
    h.deps.report = (r: Report) => {
        report(r);
        if (r.phase === 'checksum') {
            assert.match(r.text, /^Sending 0\.01 SOL to Henry\. Checksum: \w+, \w+, \w+\.$/);
            return new Promise<void>((res) =>
                setTimeout(() => {
                    h.trace.push('speech:done');
                    spokenAt = h.trace.length;
                    res();
                }, 20),
            );
        }
    };
    assert.equal((await runSend(intent(), h.deps)).ok, true);
    assert.ok(spokenAt > 0);
    assert.ok(h.trace.indexOf('speech:done') < h.trace.indexOf('dev:0x10'), h.trace.join(' '));
});

test('a stuck or failing app voice never blocks the send', async () => {
    const makers = [() => new Promise<void>(() => undefined), () => Promise.reject(new Error('tts down'))];
    for (const make of makers) {
        const h = harness([hello(2), signs()]);
        const report = h.deps.report;
        h.deps.report = (r: Report) => {
            report(r);
            return r.phase === 'checksum' ? make() : undefined;
        };
        const out = await runSend(intent(), { ...h.deps, checksumWaitMs: 30 });
        assert.equal(out.ok, true);
    }
});

test('cancel before the device is asked: nothing reaches the device, nothing is sent', async () => {
    const h = harness([]);
    const out = await runSend(intent(), { ...h.deps, cancelled: () => true });
    assert.equal(out.ok, false);
    assert.deepEqual(h.trace, ['rpc:balance']);
    assert.equal(h.reports.at(-1)?.text, 'Cancelled. Nothing was sent.');
    assert.equal(h.reports.at(-1)?.level, 'info');
});

test('cancel during PIN entry: no blockhash, no SIGN_REQUEST', async () => {
    let cancelled = false;
    const h = harness([hello(1), unlockOk()]);
    const out = await runSend(intent(), {
        ...h.deps,
        unlock: async () => {
            const st = await h.deps.unlock();
            cancelled = true; // the user said "cancel" while the PIN was being entered
            return st;
        },
        cancelled: () => cancelled,
    });
    assert.equal(out.ok, false);
    assert.deepEqual(h.trace, ['rpc:balance', 'dev:0x1', 'dev:0x4']);
    assert.equal(h.sent.length, 0);
});
