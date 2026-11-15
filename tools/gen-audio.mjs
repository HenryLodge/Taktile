#!/usr/bin/env node
// Generate the device's audio clips with ElevenLabs text-to-speech (docs/AUDIO.md).
//
//   node tools/gen-audio.mjs --dry-run            what would be generated; no API calls
//   node tools/gen-audio.mjs --only send,A,342     a few clips (by id, name or exact text)
//   node tools/gen-audio.mjs                      every clip in tools/clips.json
//   options: --limit N, --force (ignore the cache), --concurrency N (default 4), --model ID
//
// Reads ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID from server/.env. The key is never printed.
// Writes tools/out/clips/<id>.pcm (s16le mono 16 kHz, what the device stores),
// tools/out/preview/<id>-<text>.wav (to listen to) and tools/out/manifest.json. Raw API responses
// are cached in tools/out/cache/, keyed by everything that affects the audio, so reruns only pay
// for clips whose text or settings changed. tools/out/ is gitignored.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizePeak, parseWav, pcmBytes, peakOf, SAMPLE_RATE, trimSilence, writeWav } from './audio.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.elevenlabs.io/v1/text-to-speech';
export const LITTLEFS_BUDGET_BYTES = 10 * 1024 * 1024; // docs/AUDIO.md

// Fixed so every clip sounds like the same speaker in the same session.
export const DEFAULT_SETTINGS = Object.freeze({
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.75, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.95 },
    seed: 1,
    apply_text_normalization: 'off', // clips.json already says exactly what to speak
    output_format: 'wav_16000', // WAV so the sample format is checked from the header, not assumed
});

// Minimal .env parser: KEY=VALUE lines, # comments, optional quotes, CRLF.
export function parseEnv(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '');
        }
        out[key] = value;
    }
    return out;
}

export function spokenText(clip) {
    return clip.say ?? clip.text;
}

export function cacheKey(clip, voiceId, settings) {
    const h = createHash('sha256');
    h.update(JSON.stringify({ text: spokenText(clip), voiceId, settings }));
    return h.digest('hex');
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';

export function selectClips(clips, { only, limit } = {}) {
    let out = clips;
    if (only && only.length) {
        const want = new Set(only.map((s) => s.trim()).filter(Boolean));
        out = clips.filter((c) => want.has(String(c.id)) || want.has(c.name) || want.has(c.text));
        const found = new Set(out.flatMap((c) => [String(c.id), c.name, c.text]));
        const unknown = [...want].filter((w) => !found.has(w));
        if (unknown.length) throw new Error(`--only: no clip matches ${unknown.join(', ')}`);
    }
    if (limit !== undefined) out = out.slice(0, limit);
    return out;
}

class FatalApiError extends Error {}

// One API call with retries on 429 / 409 / 5xx / network errors.
async function synthesize(clip, { apiKey, voiceId, settings, fetchImpl, sleep, redact }) {
    const { output_format, ...body } = settings;
    const url = `${API}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(output_format)}`;
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/wav' },
                body: JSON.stringify({ text: spokenText(clip), ...body }),
            });
        } catch (e) {
            if (attempt >= 5) throw new Error(`clip ${clip.id}: network error: ${redact(String(e.message ?? e))}`);
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        const detail = redact((await res.text().catch(() => '')).slice(0, 300));
        // 429 rate limit, 409 "already_running" (concurrent first use of a voice), 5xx: retry later.
        if ((res.status === 429 || res.status === 409 || res.status >= 500) && attempt < 5) {
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        const hint =
            res.status === 401 ? ' (check ELEVENLABS_API_KEY in server/.env)'
            : res.status === 404 ? ' (check ELEVENLABS_VOICE_ID in server/.env)'
            : '';
        throw new FatalApiError(`clip ${clip.id} ("${clip.text}"): HTTP ${res.status}${hint}: ${detail}`);
    }
}

// Turn a cached API response into the device clip: check format, trim, normalize.
export function processResponse(wavBytes) {
    const raw = parseWav(wavBytes);
    return normalizePeak(trimSilence(raw));
}

export async function run({
    clips,
    apiKey,
    voiceId,
    outDir,
    settings = DEFAULT_SETTINGS,
    fetchImpl = globalThis.fetch,
    log = console.log,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    concurrency = 4,
    force = false,
    dryRun = false,
}) {
    const redact = (s) => (apiKey ? String(s).split(apiKey).join('***') : String(s));
    const say = (s) => log(redact(s));
    const dirs = { cache: join(outDir, 'cache'), clips: join(outDir, 'clips'), preview: join(outDir, 'preview') };

    const jobs = clips.map((c) => {
        const key = cacheKey(c, voiceId, settings);
        return { clip: c, key, cached: !force && existsSync(join(dirs.cache, `${key}.wav`)) };
    });
    const toFetch = jobs.filter((j) => !j.cached);
    const chars = toFetch.reduce((n, j) => n + spokenText(j.clip).length, 0);
    say(`${clips.length} clip(s): ${jobs.length - toFetch.length} cached, ${toFetch.length} to generate (${chars} characters)`);
    if (dryRun) {
        for (const j of toFetch) say(`  would generate ${j.clip.id} ${j.clip.name}: "${spokenText(j.clip)}"`);
        return { generated: 0, cached: jobs.length - toFetch.length, chars, dryRun: true };
    }
    if (toFetch.length && (!apiKey || !voiceId)) {
        throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must be set in server/.env');
    }
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

    // Fetch missing responses, a few at a time. Validate each before caching it.
    let next = 0;
    let fatal = null;
    let done = 0;
    const worker = async () => {
        while (!fatal && next < toFetch.length) {
            const j = toFetch[next++];
            try {
                const wav = await synthesize(j.clip, { apiKey, voiceId, settings, fetchImpl, sleep, redact });
                try {
                    processResponse(wav); // never cache a bad response
                } catch (e) {
                    throw new Error(`clip ${j.clip.id} ("${j.clip.text}"): ${e.message}`);
                }
                writeFileSync(join(dirs.cache, `${j.key}.wav`), wav);
                done++;
                if (done % 25 === 0 || done === toFetch.length) say(`  generated ${done}/${toFetch.length}`);
            } catch (e) {
                // Auth or request errors stop everything; a bad clip is reported and the rest go on.
                if (e instanceof FatalApiError) fatal = fatal ?? e;
                else failed.push({ clip: j.clip, message: redact(e.message) });
            }
        }
    };
    const failed = [];
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, toFetch.length)) }, worker));
    if (fatal) throw new Error(redact(fatal.message));
    if (failed.length) {
        for (const f of failed) say(`  FAILED ${f.message}`);
        throw new Error(`${failed.length} clip(s) failed (the rest are cached); fix them (e.g. a "say" override in gen-clips.mjs) and rerun`);
    }

    // Build outputs from the cache (deterministic).
    const manifestPath = join(outDir, 'manifest.json');
    const manifest = new Map();
    if (existsSync(manifestPath)) {
        for (const m of JSON.parse(readFileSync(manifestPath, 'utf8'))) manifest.set(m.id, m);
    }
    const warnings = [];
    for (const j of jobs) {
        const samples = processResponse(readFileSync(join(dirs.cache, `${j.key}.wav`)));
        const ms = Math.round((samples.length * 1000) / SAMPLE_RATE);
        if (ms < 100 || ms > 4000) warnings.push(`clip ${j.clip.id} "${j.clip.text}" is ${ms} ms`);
        writeFileSync(join(dirs.clips, `${j.clip.id}.pcm`), pcmBytes(samples));
        writeFileSync(join(dirs.preview, `${String(j.clip.id).padStart(3, '0')}-${slug(j.clip.text)}.wav`), writeWav(samples));
        manifest.set(j.clip.id, {
            id: j.clip.id, name: j.clip.name, text: j.clip.text, say: j.clip.say, ms, peak: peakOf(samples), cache: j.key,
        });
    }
    writeFileSync(manifestPath, JSON.stringify([...manifest.values()].sort((a, b) => a.id - b.id), null, 2) + '\n');

    let bytes = 0;
    let totalMs = 0;
    for (const f of readdirSync(dirs.clips)) {
        if (f.endsWith('.pcm')) bytes += statSync(join(dirs.clips, f)).size;
    }
    for (const m of manifest.values()) totalMs += m.ms;
    for (const w of warnings) say(`  warning: ${w}`);
    say(
        `done: ${toFetch.length} generated, ${jobs.length - toFetch.length} from cache, ${chars} characters sent; ` +
            `${manifest.size} clip(s) in tools/out, ${(totalMs / 1000).toFixed(1)} s of audio, ` +
            `${(bytes / 1048576).toFixed(2)} MB of ${(LITTLEFS_BUDGET_BYTES / 1048576).toFixed(0)} MB budget`,
    );
    return { generated: toFetch.length, cached: jobs.length - toFetch.length, chars, bytes, warnings };
}

function parseArgs(argv) {
    const opts = { only: null, limit: undefined, force: false, dryRun: false, concurrency: 4, model: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--only') opts.only = (argv[++i] ?? '').split(',');
        else if (a === '--limit') opts.limit = Number(argv[++i]);
        else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
        else if (a === '--model') opts.model = argv[++i];
        else throw new Error(`unknown option ${a}`);
    }
    return opts;
}

async function main(argv) {
    const opts = parseArgs(argv);
    const clips = selectClips(JSON.parse(readFileSync(join(ROOT, 'tools/clips.json'), 'utf8')), opts);
    const envPath = join(ROOT, 'server/.env');
    const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
    const settings = opts.model ? { ...DEFAULT_SETTINGS, model_id: opts.model } : DEFAULT_SETTINGS;
    await run({
        clips,
        apiKey: env.ELEVENLABS_API_KEY,
        voiceId: env.ELEVENLABS_VOICE_ID,
        outDir: join(ROOT, 'tools/out'),
        settings,
        concurrency: opts.concurrency,
        force: opts.force,
        dryRun: opts.dryRun,
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(`gen-audio: ${e.message}`);
        process.exitCode = 1;
    });
}
