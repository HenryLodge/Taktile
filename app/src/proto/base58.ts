// Base58 (Bitcoin alphabet), encode only: to show the device's address.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) {
        zeros++;
    }
    let n = 0n;
    for (const b of bytes) {
        n = (n << 8n) | BigInt(b);
    }
    let s = '';
    while (n > 0n) {
        s = ALPHABET[Number(n % 58n)] + s;
        n /= 58n;
    }
    return '1'.repeat(zeros) + s;
}
