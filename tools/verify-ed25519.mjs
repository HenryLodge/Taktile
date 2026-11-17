// Verifies the Ed25519 signatures printed by the device's bring-up step 0, using Node's built-in
// node:crypto (no dependency). Each line looks like:
//   ED25519 pub=<64 hex> msg=<hex> sig=<128 hex>
//
//   python step.py COM3 0 8 | node tools/verify-ed25519.mjs
//   node tools/verify-ed25519.mjs saved-output.txt
//
// Exits 1 if any signature is bad or if no ED25519 line was found.

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// DER SubjectPublicKeyInfo header for a raw 32-byte Ed25519 key (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LINE = /ED25519 pub=([0-9a-f]{64}) msg=((?:[0-9a-f]{2})*) sig=([0-9a-f]{128})/g;

export function verifyOne(pubHex, msgHex, sigHex) {
    try {
        const key = createPublicKey({
            key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubHex, 'hex')]),
            format: 'der',
            type: 'spki',
        });
        return verify(null, Buffer.from(msgHex, 'hex'), key, Buffer.from(sigHex, 'hex'));
    } catch {
        return false; // e.g. a public key that isn't a valid curve point
    }
}

// Returns [{pub, msg, sig, ok}] for every ED25519 line in text.
export function verifyText(text) {
    return [...text.matchAll(LINE)].map(([, pub, msg, sig]) => ({ pub, msg, sig, ok: verifyOne(pub, msg, sig) }));
}

function main(args) {
    const text = readFileSync(args[0] ?? 0, 'utf8');
    const results = verifyText(text);
    for (const r of results) {
        console.log(`${r.ok ? 'OK ' : 'BAD'} pub=${r.pub.slice(0, 16)}... msg ${r.msg.length / 2} bytes`);
    }
    if (results.length === 0) {
        console.error('no ED25519 lines found');
        return 1;
    }
    const bad = results.filter((r) => !r.ok).length;
    console.log(bad ? `${bad} of ${results.length} signatures BAD` : `all ${results.length} signatures OK`);
    return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv.slice(2));
}
