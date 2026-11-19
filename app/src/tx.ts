// Devnet transaction building (docs/SOLANA.md). The app builds legacy messages with web3.js exactly
// the way tools/gen-vectors.mjs does, so the device's parser is already proven against this output
// (tx.test.ts checks byte equality with tests/vectors/parser.json). The device is the fee payer and
// the only signer (I5).

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

export const EXPLORER_TX = (sig: string): string => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const FEE_LAMPORTS = 5000n; // one signature

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
