// Devnet transaction building (docs/SOLANA.md). The app builds legacy messages with web3.js exactly
// the way tools/gen-vectors.mjs does, so the device's parser is already proven against this output
// (tx.test.ts checks byte equality with tests/vectors/parser.json). The device is the fee payer and
// the only signer (I5).

import {
    Authorized,
    Lockup,
    PublicKey,
    StakeProgram,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

export const EXPLORER_TX = (sig: string): string => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const FEE_LAMPORTS = 5000n; // one signature

// Pinned constants (docs/SOLANA.md, core/include/tk_solana_consts.h; tx.test.ts cross-checks them
// against tools/gen-consts.mjs). Devnet USDC only (I9).
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const USDC_DECIMALS = 6;
const TRANSFER_CHECKED = 12;

/** The wallet's devnet-USDC associated token account (SOLANA.md "On-device ATA derivation"). */
export function usdcAta(wallet: Uint8Array): Uint8Array {
    const [ata] = PublicKey.findProgramAddressSync(
        [new PublicKey(wallet).toBuffer(), TOKEN_PROGRAM.toBuffer(), DEVNET_USDC_MINT.toBuffer()],
        ATA_PROGRAM,
    );
    return ata.toBytes();
}

/**
 * Shape B: SPL Token TransferChecked of devnet USDC from the device's token account to the
 * recipient's, signed by the device as owner. Built by hand (no spl-token in the browser) with the
 * same layout as spl-token's createTransferCheckedInstruction: data = [12, amount u64 LE, decimals],
 * accounts = [source (w), mint, destination (w), owner (signer)].
 */
export function usdcTransferMessageToAta(
    device: Uint8Array,
    sourceAta: Uint8Array,
    destAta: Uint8Array,
    amount: bigint,
    blockhash: string,
): Uint8Array {
    const owner = new PublicKey(device);
    const source = new PublicKey(sourceAta);
    const dest = new PublicKey(destAta);
    if (source.equals(dest)) {
        throw new Error('cannot send to the device itself');
    }
    if (amount < 0n || amount >= 1n << 64n) {
        throw new Error('amount out of range');
    }
    const data = Buffer.alloc(10);
    data[0] = TRANSFER_CHECKED;
    data.writeBigUInt64LE(amount, 1);
    data[9] = USDC_DECIMALS;
    const ix = new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: DEVNET_USDC_MINT, isSigner: false, isWritable: false },
            { pubkey: dest, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: false },
        ],
        data,
    });
    const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
    tx.add(ix);
    return new Uint8Array(tx.compileMessage().serialize());
}

/** Shape B to a wallet: both token accounts derived here, exactly as the device derives them. */
export function usdcTransferMessage(device: Uint8Array, to: Uint8Array, amount: bigint, blockhash: string): Uint8Array {
    return usdcTransferMessageToAta(device, usdcAta(device), usdcAta(to), amount, blockhash);
}

/** Shape A: System Program transfer from the device to `to`. Returns the message bytes for SIGN_REQUEST. */
export function solTransferMessage(
    device: Uint8Array,
    to: Uint8Array,
    lamports: bigint,
    blockhash: string,
): Uint8Array {
    const from = new PublicKey(device);
    const dest = new PublicKey(to);
    if (from.equals(dest)) {
        throw new Error('cannot send to the device itself');
    }
    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash });
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports }));
    return new Uint8Array(tx.compileMessage().serialize());
}

// ---- Staking (Shapes C and D, docs/SOLANA.md): byte-equal to tests/vectors/parser.json stake_ok_* ----

export const STAKE_SPACE = 200;
export const STAKE_SEEDS = 16;
export const stakeSeed = (n: number): string => `tk-stake-${n}`;

/** The device's own stake account tk-stake-<n> (createWithSeed: base = device, owner = Stake Program). */
export async function stakeAccount(device: Uint8Array, n: number): Promise<PublicKey> {
    if (!Number.isInteger(n) || n < 0 || n >= STAKE_SEEDS) {
        throw new Error('stake account index must be 0-15');
    }
    return PublicKey.createWithSeed(new PublicKey(device), stakeSeed(n), StakeProgram.programId);
}

/**
 * Shape C: create stake account n with `lamports` (the stake plus the rent-exempt reserve),
 * initialize it with the device as staker and withdrawer and no lockup, and delegate it to `vote`
 * (the pinned validator; the device refuses any other). Returns the message bytes for SIGN_REQUEST.
 */
export async function stakeMessage(
    device: Uint8Array,
    n: number,
    lamports: bigint,
    vote: string,
    blockhash: string,
): Promise<Uint8Array> {
    if (lamports < 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('stake amount out of range'); // web3.js takes lamports as a number here
    }
    const me = new PublicKey(device);
    const stake = await stakeAccount(device, n);
    const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash });
    tx.add(
        SystemProgram.createAccountWithSeed({
            fromPubkey: me,
            newAccountPubkey: stake,
            basePubkey: me,
            seed: stakeSeed(n),
            lamports: Number(lamports),
            space: STAKE_SPACE,
            programId: StakeProgram.programId,
        }),
        StakeProgram.initialize({
            stakePubkey: stake,
            authorized: new Authorized(me, me),
            lockup: new Lockup(0, 0, PublicKey.default),
        }),
        StakeProgram.delegate({ stakePubkey: stake, authorizedPubkey: me, votePubkey: new PublicKey(vote) }),
    );
    return new Uint8Array(tx.compileMessage().serialize());
}

/** Shape D: deactivate stake account n. */
export async function unstakeMessage(device: Uint8Array, n: number, blockhash: string): Promise<Uint8Array> {
    const me = new PublicKey(device);
    const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash });
    tx.add(StakeProgram.deactivate({ stakePubkey: await stakeAccount(device, n), authorizedPubkey: me }));
    return new Uint8Array(tx.compileMessage().serialize());
}

/** A one-signer transaction: compact-u16 1, the signature, the message. */
export function signedTransaction(signature: Uint8Array, message: Uint8Array): Uint8Array {
    if (signature.length !== 64) {
        throw new Error('signature must be 64 bytes');
    }
    const out = new Uint8Array(1 + 64 + message.length);
    out[0] = 1;
    out.set(signature, 1);
    out.set(message, 65);
    return out;
}

/** Ed25519 check of the device's signature over exactly these message bytes (WebCrypto). */
export async function verifySignature(
    pubkey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
): Promise<boolean> {
    if (pubkey.length !== 32 || signature.length !== 64) {
        return false;
    }
    try {
        const key = await crypto.subtle.importKey('raw', pubkey, { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
    } catch {
        return false;
    }
}
