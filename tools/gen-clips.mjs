#!/usr/bin/env node
// Clip list: the text of every clip in core/include/tk_clips.h.
//
//   node tools/gen-clips.mjs           write tools/clips.json, sim/src/clip_text.c and
//                                      core/include/tk_clips_fp.h
//   node tools/gen-clips.mjs --check   write nothing; exit 1 if any is stale
//
// clips.json entries: {id, name, text, say?}. text is what the clip says (and what sim/ prints);
// say, when present, is sent to text-to-speech instead (a pronunciation fix found by listening).
// No dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWords } from './gen-words.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = 'core/include/tk_clips.h';

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
    'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

// Text for each enum name. Ranges (an anchor followed by unnamed entries) take an array.
export const TEXT = {
    TK_CLIP_WORD_0: () => loadWords(),
    TK_CLIP_ZERO: () => NUMBERS,
    TK_CLIP_TWENTY: () => TENS,
    TK_CLIP_HUNDRED: 'hundred',
    TK_CLIP_THOUSAND: 'thousand',
    TK_CLIP_MILLION: 'million',
    TK_CLIP_BILLION: 'billion',
    TK_CLIP_TRILLION: 'trillion',
    TK_CLIP_POINT: 'point',
    TK_CLIP_LETTER_A: () => LETTERS,
    TK_CLIP_SPACE: 'space',
    TK_CLIP_HYPHEN: 'hyphen',
    TK_CLIP_APOSTROPHE: 'apostrophe',
    TK_CLIP_SOL: 'SOL',
    TK_CLIP_USDC: 'USDC',
    TK_CLIP_SEND: 'send',
    TK_CLIP_TO: 'to',
    TK_CLIP_UNKNOWN_RECIPIENT: 'unknown recipient, do not sign',
    TK_CLIP_CANNOT_SIGN: 'cannot sign this transaction',
    TK_CLIP_PRESS_CONFIRM: 'press confirm to sign or reject to cancel',
    TK_CLIP_CHECKSUM: 'checksum',
    TK_CLIP_ADDRESS_PHRASE: 'address phrase',
    TK_CLIP_ENTER_PIN: 'enter pin',
    TK_CLIP_DIGIT: 'pin digit number',
    TK_CLIP_WRONG_PIN: 'wrong pin',
    TK_CLIP_ATTEMPTS_REMAINING: 'attempts remaining',
    TK_CLIP_SIGNED: 'signed',
    TK_CLIP_CANCELLED: 'cancelled',
    TK_CLIP_ADDING_CONTACT: 'adding contact',
    TK_CLIP_REMOVE: 'remove',
    TK_CLIP_CONTACT_BOOK_FULL: 'contact book full',
    TK_CLIP_ALREADY_A_CONTACT: 'already a contact',
    TK_CLIP_RECOVERY_WORD: 'recovery word',
    TK_CLIP_REPEAT: 'repeat',
    TK_CLIP_SPEAKER_MODE_ON: 'speaker mode on',
    TK_CLIP_WALLET_WIPED: 'wallet wiped',
    TK_CLIP_WRITE_DOWN: 'write down your recovery words',
    TK_CLIP_NEXT_WORD_HELP: 'press OK for the next word, hold OK to repeat',
    TK_CLIP_REPLAY_ALL: 'hold OK to hear all words again, or press OK to finish',
    TK_CLIP_CHOOSE_PIN: 'choose a new PIN',
    TK_CLIP_ENTER_PIN_AGAIN: 'enter your PIN again',
    TK_CLIP_PINS_DONT_MATCH: 'the PINs do not match',
    TK_CLIP_PLEASE_WAIT: 'please wait',
    TK_CLIP_WALLET_CREATED: 'wallet created',
    TK_CLIP_SPEAKER_MODE_OFF: 'speaker mode off',
    TK_CLIP_STARTING_AT: 'starting at',
    TK_CLIP_TWENTY_ONE: () => ['twenty one', 'twenty two', 'twenty three', 'twenty four'],
    TK_CLIP_PRESS_CONFIRM_ADD: 'press confirm to add or reject to cancel',
    TK_CLIP_CONTACT_ADDED: 'contact added',
};

// Pronunciation fixes, by clip name (see the header comment). Empty until listening says otherwise.
// Letters: a bare "A" or "B" is read as a sound ("ah", "buh"; heard on the device 2026-11-17), and a
// lone "S" came back silent (2026-11-14), so every letter is sent as its spoken name. (An
// English-forced model, eleven_turbo_v2_5 with language_code "en", was tried 2026-11-17 and sounded
// worse on more letters.)
const LETTER_NAMES = ['ay', 'bee', 'see', 'dee', 'ee', 'eff', 'gee', 'aitch', 'eye', 'jay', 'kay', 'el', 'em',
    'en', 'oh', 'pee', 'cue', 'ar', 'ess', 'tee', 'you', 'vee', 'double you', 'ex', 'why', 'zee'];
const letterName = (i) => (i === 0 ? 'TK_CLIP_LETTER_A' : `TK_CLIP_LETTER_A+${i}`);

// Letters whose plain name came out wrong, with the version picked by listening (2026-11-17,
// candidates generated three or four ways): a different text, or the same name with another seed.
const LETTER_PICKS = {
    A: { say: 'ey.' }, // round 2: Spanish spelling of the English sound (the voice read "ay" as Spanish)
    D: { say: 'dee.' },
    E: { say: 'ii.' }, // round 2, same reason
    G: { say: 'gee.' },
    H: { seed: 2 }, // "aitch"
    K: { seed: 2 }, // "kay"
    L: { say: 'ell.' },
    M: { say: 'emm.' },
    N: { say: 'enn.' },
    V: { say: 'vii.' }, // round 2
};
const pickFor = (i) => LETTER_PICKS[String.fromCharCode(65 + i)];

export const SAY = Object.fromEntries(LETTER_NAMES.map((say, i) => [letterName(i), pickFor(i)?.say ?? say]));

// Per-clip text-to-speech settings, merged over gen-audio's defaults (and part of the cache key).
export const TTS = Object.fromEntries(
    LETTER_NAMES.flatMap((_, i) => (pickFor(i)?.seed !== undefined ? [[letterName(i), { seed: pickFor(i).seed }]] : [])),
);

// Parse `typedef enum { ... } tk_clip_t;` into [{name, value}] in declaration order. Supports
// NAME, NAME = <int>, NAME = OTHER, NAME = OTHER + <int>.
export function parseClipEnum(src) {
    const start = src.indexOf('typedef enum {');
    const end = src.indexOf('} tk_clip_t;');
    if (start < 0 || end < start) {
        throw new Error(`${HEADER}: tk_clip_t enum not found`);
    }
    const body = src
        .slice(start + 'typedef enum {'.length, end)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const values = new Map();
    const out = [];
    let next = 0;
    for (const raw of body.split(',')) {
        const entry = raw.trim();
        if (entry === '') continue;
        const m = entry.match(/^([A-Z][A-Z0-9_]*)\s*(?:=\s*(.+))?$/s);
        if (!m) throw new Error(`${HEADER}: cannot parse enum entry ${JSON.stringify(entry)}`);
        let value = next;
        if (m[2] !== undefined) {
            const e = m[2].trim();
            const em = e.match(/^(?:([A-Z][A-Z0-9_]*)\s*(?:\+\s*(\d+))?|(\d+))$/);
            if (!em) throw new Error(`${HEADER}: unsupported expression ${JSON.stringify(e)}`);
            if (em[3] !== undefined) {
                value = Number(em[3]);
            } else {
                if (!values.has(em[1])) throw new Error(`${HEADER}: ${em[1]} used before it is defined`);
                value = values.get(em[1]) + Number(em[2] ?? 0);
            }
        }
        values.set(m[1], value);
        out.push({ name: m[1], value });
        next = value + 1;
    }
    return out;
}

// One entry per clip ID, 0 .. TK_CLIP_COUNT-1.
export function buildClips(headerSrc = readFileSync(join(ROOT, HEADER), 'utf8')) {
    const entries = parseClipEnum(headerSrc);
    const countEntry = entries.find((e) => e.name === 'TK_CLIP_COUNT');
    if (!countEntry) throw new Error(`${HEADER}: TK_CLIP_COUNT missing`);
    const anchors = entries.filter((e) => e.name !== 'TK_CLIP_COUNT');
    for (const name of Object.keys(TEXT)) {
        if (!anchors.some((a) => a.name === name)) throw new Error(`text for ${name}, which is not in ${HEADER}`);
    }
    const clips = new Array(countEntry.value).fill(null);
    // Each anchor owns the IDs up to the next anchor's value.
    const sorted = [...anchors].sort((a, b) => a.value - b.value);
    for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        const end = i + 1 < sorted.length ? sorted[i + 1].value : countEntry.value;
        if (sorted[i + 1] && sorted[i + 1].value === a.value) {
            throw new Error(`${HEADER}: ${a.name} and ${sorted[i + 1].name} share ID ${a.value}`);
        }
        const t = TEXT[a.name];
        if (t === undefined) throw new Error(`no text for ${a.name}`);
        const texts = typeof t === 'function' ? t() : [t];
        if (texts.length !== end - a.value) {
            throw new Error(`${a.name}: ${texts.length} text(s) for ${end - a.value} ID(s)`);
        }
        texts.forEach((text, k) => {
            const id = a.value + k;
            const name = k === 0 ? a.name : `${a.name}+${k}`;
            const clip = { id, name, text };
            if (SAY[name] !== undefined) clip.say = SAY[name];
            if (TTS[name] !== undefined) clip.tts = { ...TTS[name] };
            clips[id] = clip;
        });
    }
    const missing = clips.findIndex((c) => c === null);
    if (missing >= 0) throw new Error(`no clip for ID ${missing}`);
    for (const c of clips) {
        if (typeof c.text !== 'string' || c.text === '' || /["\\\n]/.test(c.text)) {
            throw new Error(`bad text for ${c.name}: ${JSON.stringify(c.text)}`);
        }
    }
    return clips;
}

function renderClipText(clips) {
    const out = [
        '// GENERATED by tools/gen-clips.mjs from core/include/tk_clips.h. Do not edit; rerun the script.',
        '// What each clip says, for sim/ to print. Same text as tools/clips.json.',
        '',
        '#include "tk_clips.h"',
        '#include "util.h"',
        '',
        'static const char *const TEXT[] = {',
    ];
    for (const c of clips) {
        out.push(`    "${c.text}", // ${c.id} ${c.name}`);
    }
    out.push(
        '};',
        '',
        '_Static_assert(sizeof(TEXT) / sizeof(TEXT[0]) == TK_CLIP_COUNT, "rerun tools/gen-clips.mjs");',
        '',
        'const char *sim_clip_text(uint16_t clip) {',
        '    return clip < TK_CLIP_COUNT ? TEXT[clip] : "(unknown clip)";',
        '}',
        '',
    );
    return out.join('\n');
}

// CRC-32 (IEEE, same as zlib and core/src/tk_crc32.c). Hand-written so any Node version works.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes, crc = 0) {
    let c = ~crc >>> 0;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}

// Identifies the clip list: CRC-32 over "<id>:<text>\n" for every clip in ID order. The clip pack
// carries it, and the device refuses a pack whose fingerprint differs, so a stale pack can never
// speak the wrong word for an ID (docs/AUDIO.md).
export function clipsFingerprint(clips) {
    return crc32(Buffer.from(clips.map((c) => `${c.id}:${c.text}\n`).join(''), 'utf8'));
}

function renderFingerprint(clips) {
    const hex = clipsFingerprint(clips).toString(16).padStart(8, '0');
    return [
        '// GENERATED by tools/gen-clips.mjs from core/include/tk_clips.h. Do not edit; rerun the script.',
        '// Fingerprint of the clip list (ID -> text). The device refuses a clip pack built for another list.',
        '',
        '#ifndef TK_CLIPS_FP_H',
        '#define TK_CLIPS_FP_H',
        '',
        `#define TK_CLIPS_FINGERPRINT 0x${hex}u`,
        '',
        '#endif',
        '',
    ].join('\n');
}

export function generate() {
    const clips = buildClips();
    return [
        ['tools/clips.json', JSON.stringify(clips, null, 2) + '\n'],
        ['sim/src/clip_text.c', renderClipText(clips)],
        ['core/include/tk_clips_fp.h', renderFingerprint(clips)],
    ];
}

function main(argv) {
    const files = generate();
    if (!argv.includes('--check')) {
        for (const [rel, text] of files) {
            writeFileSync(join(ROOT, rel), text);
            console.log(`wrote ${rel}`);
        }
        return 0;
    }
    let ok = true;
    for (const [rel, text] of files) {
        let current = null;
        try {
            current = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
        } catch {
            // missing: reported below
        }
        if (current !== text) {
            console.error(`stale: ${rel} (run node tools/gen-clips.mjs)`);
            ok = false;
        }
    }
    if (ok) console.log('clips: up to date');
    return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv.slice(2));
}
