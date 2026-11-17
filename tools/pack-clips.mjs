#!/usr/bin/env node
// Clip pack: every clip in one flat image for the device's `clips` partition (docs/AUDIO.md).
//
//   node tools/pack-clips.mjs           write tools/out/clips.bin from tools/out/clips/<id>.pcm
//   node tools/pack-clips.mjs --check   write nothing; exit 1 if clips.bin is missing or stale
//
// Layout (all little-endian), parsed on the device by core/src/tk_clippack.c:
//   0  "TKCP"            magic
//   4  u16 version        1
//   6  u16 count          TK_CLIP_COUNT
//   8  u32 total_len      bytes in the whole pack
//  12  u32 fingerprint    clipsFingerprint() of tools/clips.json (TK_CLIPS_FINGERPRINT)
//  16  u32 data_crc       CRC-32 of bytes [data_start, total_len)
//  20  count x {u32 offset, u32 len}   offset from the start of the pack; len in bytes (even)
//  data_start = 20 + 8 * count; each clip starts on a 4-byte boundary (zero padding between)
//
// Clips are s16le mono 16 kHz PCM from tools/gen-audio.mjs. The tool checks that every clip was
// generated from the current text (tools/out/manifest.json), so the pack can't be stale.
// Flash it with: parttool.py -p COMx write_partition --partition-name clips --input tools/out/clips.bin
// No dependencies.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { clipsFingerprint, crc32 } from './gen-clips.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HEADER_LEN = 20;
export const VERSION = 1;
export const PACK_BUDGET_BYTES = 0xa00000; // the `clips` partition in firmware/partitions.csv

// clips: tools/clips.json entries. pcmFor(clip) returns that clip's PCM bytes.
export function buildPack(clips, pcmFor) {
    clips.forEach((c, i) => {
        if (c.id !== i) throw new Error(`clips.json: entry ${i} has id ${c.id}`);
    });
    const pcms = clips.map((c) => {
        const pcm = pcmFor(c);
        if (pcm.length === 0 || pcm.length % 2 !== 0) {
            throw new Error(`clip ${c.id} (${c.name}): ${pcm.length} bytes, need an even, non-zero length`);
        }
        return pcm;
    });
    const dataStart = HEADER_LEN + 8 * clips.length;
    let total = dataStart;
    const index = pcms.map((p) => {
        total = (total + 3) & ~3;
        const entry = { offset: total, len: p.length };
        total += p.length;
        return entry;
    });
    if (total > PACK_BUDGET_BYTES) throw new Error(`pack is ${total} bytes, over the ${PACK_BUDGET_BYTES}-byte partition`);

    const buf = Buffer.alloc(total);
    buf.write('TKCP', 0, 'ascii');
    buf.writeUInt16LE(VERSION, 4);
    buf.writeUInt16LE(clips.length, 6);
    buf.writeUInt32LE(total, 8);
    buf.writeUInt32LE(clipsFingerprint(clips), 12);
    index.forEach((e, i) => {
        buf.writeUInt32LE(e.offset, HEADER_LEN + 8 * i);
        buf.writeUInt32LE(e.len, HEADER_LEN + 8 * i + 4);
        pcms[i].copy(buf, e.offset);
    });
    buf.writeUInt32LE(crc32(buf.subarray(dataStart)), 16);
    return buf;
}

// The pack from tools/out, after checking each clip was generated from the current clips.json text.
export function packFromOut(outDir = join(ROOT, 'tools/out')) {
    const clips = JSON.parse(readFileSync(join(ROOT, 'tools/clips.json'), 'utf8'));
    const manifestPath = join(outDir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`${manifestPath} missing: run node tools/gen-audio.mjs first`);
    const manifest = new Map(JSON.parse(readFileSync(manifestPath, 'utf8')).map((m) => [m.id, m]));
    return buildPack(clips, (c) => {
        const m = manifest.get(c.id);
        if (!m || m.text !== c.text) {
            throw new Error(`clip ${c.id} (${c.name}) was generated for ${JSON.stringify(m?.text)}, ` +
                `not ${JSON.stringify(c.text)}: rerun node tools/gen-audio.mjs`);
        }
        const path = join(outDir, 'clips', `${c.id}.pcm`);
        if (!existsSync(path)) throw new Error(`${path} missing: rerun node tools/gen-audio.mjs`);
        return readFileSync(path);
    });
}

function main(argv) {
    const out = join(ROOT, 'tools/out/clips.bin');
    const pack = packFromOut();
    if (argv.includes('--check')) {
        if (!existsSync(out) || !readFileSync(out).equals(pack)) {
            console.error('stale: tools/out/clips.bin (run node tools/pack-clips.mjs)');
            return 1;
        }
        console.log('clip pack: up to date');
        return 0;
    }
    writeFileSync(out, pack);
    console.log(`wrote tools/out/clips.bin: ${pack.readUInt16LE(6)} clips, ${(pack.length / 1048576).toFixed(2)} MB, ` +
        `fingerprint 0x${pack.readUInt32LE(12).toString(16).padStart(8, '0')}`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}
