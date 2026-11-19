// node --test tools/   (no network)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
    AIRDROP_BELOW,
    ATA_PROGRAM,
    TOKEN_PROGRAM,
    USDC_MINT,
    attacker,
    parseArgs,
    planActions,
    usdcAta,
} from './setup-devnet.mjs';

const A = Keypair.fromSeed(createHash('sha256').update('taktile-vector:alice').digest()).publicKey;
const B = Keypair.fromSeed(createHash('sha256').update('taktile-vector:bob').digest()).publicKey;

test('parseArgs', () => {
    const r = parseArgs(['--device', A.toBase58(), '--contact', `Henry=${B.toBase58()}`, '--dry-run']);
    assert.ok(r.device.equals(A));
    assert.equal(r.contacts[0].name, 'Henry');
    assert.ok(r.contacts[0].wallet.equals(B));
    assert.equal(r.dryRun, true);
    assert.equal(parseArgs(['--device', A.toBase58()]).dryRun, false);
    assert.throws(() => parseArgs([]), /--device is required/);
    assert.throws(() => parseArgs(['--device']), /needs a value/);
    assert.throws(() => parseArgs(['--device', 'nope']), /not a Solana address/);
    assert.throws(() => parseArgs(['--device', A.toBase58(), '--contact', 'Henry']), /NAME=ADDRESS/);
    assert.throws(() => parseArgs(['--device', A.toBase58(), '--contact', `Al!ce=${B.toBase58()}`]), /NAME=ADDRESS/);
    assert.throws(() => parseArgs(['--device', A.toBase58(), '--mainnet']), /unknown argument/);
    assert.throws(() => parseArgs(['--device', usdcAta(A).toBase58()]), /not a wallet address/);
});

test('planActions: airdrop only when low, create only what is missing', () => {
    const owners = { device: A, Henry: B, attacker: attacker() };
    const acct = (label, exists) => ({ label, owner: owners[label], ata: usdcAta(owners[label]), exists });
    const none = planActions({
        payerLamports: AIRDROP_BELOW,
        deviceLamports: AIRDROP_BELOW,
        accounts: [acct('device', true), acct('Henry', true)],
    });
    assert.deepEqual(none.airdrops, []);
    assert.deepEqual(none.create, []);

    const some = planActions({
        payerLamports: AIRDROP_BELOW - 1,
        deviceLamports: 0,
        accounts: [acct('device', false), acct('Henry', true), acct('attacker', false)],
    });
    assert.deepEqual(
        some.airdrops.map((a) => a.key),
        ['payer', 'device'],
    );
    assert.deepEqual(
        some.create.map((c) => c.label),
        ['device', 'attacker'],
    );
    assert.ok(some.payerNeeds > 2 * 2_000_000);
});

test('planActions: the same account is created once', () => {
    const p = planActions({
        payerLamports: AIRDROP_BELOW,
        deviceLamports: AIRDROP_BELOW,
        accounts: [
            { label: 'device', owner: A, ata: usdcAta(A), exists: false },
            { label: 'Henry', owner: A, ata: usdcAta(A), exists: false },
        ],
    });
    assert.equal(p.create.length, 1);
});

test('attacker is fixed and its USDC account is the standard ATA', () => {
    const a = attacker();
    assert.ok(a.equals(attacker()));
    assert.ok(a.equals(Keypair.fromSeed(createHash('sha256').update('taktile-demo:attacker').digest()).publicKey));
    const [ata] = PublicKey.findProgramAddressSync([a.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()], ATA_PROGRAM);
    assert.ok(usdcAta(a).equals(ata));
});

test('pinned constants are devnet USDC and the classic token program', () => {
    assert.equal(USDC_MINT.toBase58(), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    assert.equal(TOKEN_PROGRAM.toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
});
