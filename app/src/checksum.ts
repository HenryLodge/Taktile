// Checksum phrases, computed the same way as the device (core/src/tk_checksum.c, docs/AUDIO.md).
//
//   tx phrase:      SHA256("TK-TX-v1"   || message_bytes)  -> bytes 0..2 pick the words
//   address phrase: SHA256("TK-ADDR-v1" || wallet_pubkey)  -> bytes 0..7 pick the words
//
// message_bytes is the serialized Solana message the app sends in SIGN_REQUEST. Shared vectors:
// tests/vectors/checksum.json. Uses Web Crypto only (Chrome, Edge, Node), no dependencies.

import { PGP_EVEN_WORDS } from './words.ts';

export const TX_PHRASE_WORDS = 3;
export const ADDR_PHRASE_WORDS = 8;
const TX_TAG = 'TK-TX-v1';
const ADDR_TAG = 'TK-ADDR-v1';

async function phraseIndices(tag: string, data: Uint8Array, n: number): Promise<number[]> {
    const tagBytes = new TextEncoder().encode(tag); // ASCII, no trailing NUL
    const input = new Uint8Array(tagBytes.length + data.length);
    input.set(tagBytes, 0);
    input.set(data, tagBytes.length);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return Array.from(h.subarray(0, n));
}

const toWords = (indices: number[]): string[] =>
    indices.map((i) => {
        const w = PGP_EVEN_WORDS[i];
        if (w === undefined) {
            throw new Error(`no checksum word at index ${i}`);
        }
        return w;
    });

export async function txPhraseIndices(message: Uint8Array): Promise<number[]> {
    return phraseIndices(TX_TAG, message, TX_PHRASE_WORDS);
}

export async function addressPhraseIndices(wallet: Uint8Array): Promise<number[]> {
    if (wallet.length !== 32) {
        throw new Error(`address phrase: wallet must be 32 bytes, got ${wallet.length}`);
    }
    return phraseIndices(ADDR_TAG, wallet, ADDR_PHRASE_WORDS);
}

/** The 3-word phrase the device will speak for these message bytes. */
export async function txPhrase(message: Uint8Array): Promise<string[]> {
    return toWords(await txPhraseIndices(message));
}

/** The 8-word phrase the device speaks when enrolling this wallet as a contact. */
export async function addressPhrase(wallet: Uint8Array): Promise<string[]> {
    return toWords(await addressPhraseIndices(wallet));
}
