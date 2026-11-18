// Disk cache for TTS audio: identical requests (prompts like "Sent.") cost credits once.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createCache(dir) {
    // Callers build `parts` with a fixed key order, so JSON.stringify is stable.
    const key = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const file = (k) => join(dir, `${k}.mp3`);

    async function get(k) {
        try {
            return await readFile(file(k));
        } catch (e) {
            if (e.code === 'ENOENT') {
                return null;
            }
            throw e;
        }
    }

    async function put(k, buf) {
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `${k}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(tmp, buf);
        await rename(tmp, file(k)); // atomic: a reader never sees half a file
    }

    return { key, get, put };
}
