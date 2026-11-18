#!/usr/bin/env node
// Live check of the ElevenLabs contract the server relies on (costs ~25 TTS characters + ~2 s of STT).
// Calls ElevenLabs directly with the key from server/.env; prints model IDs, HTTP statuses and
// transcripts only, never the key.
//
//   npm run probe
//
// 1. GET /v1/models: is the TTS model (TK_TTS_MODEL, default eleven_flash_v2_5) available?
// 2. TTS "Send one USDC to Henry." as WAV with the app voice -> cache/probe-sample.wav
// 3. STT that WAV with TK_STT_MODEL (default scribe_v2), keyterms as repeated fields; on a 4xx, tries a
//    JSON keyterms field, then no keyterms, then scribe_v1, and says which worked.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRedactor } from './lib/http.mjs';
import { BASE_KEYTERMS, buildSttForm } from './lib/stt.mjs';
import { API } from './lib/upstream.mjs';
import { loadConfig } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_TEXT = 'Send one USDC to Henry.';

async function main() {
    const config = loadConfig(process.env);
    if (!config.apiKey || !config.voiceId) {
        console.log('Set ELEVENLABS_API_KEY and ELEVENLABS_APP_VOICE_ID (or ELEVENLABS_VOICE_ID) in server/.env');
        return 1;
    }
    const redact = makeRedactor(config.apiKey);
    const headers = { 'xi-api-key': config.apiKey };
    const detail = async (res) => redact((await res.text()).slice(0, 300));
    const env = [];

    // 1. models
    // Optional: a scoped key without the models_read permission can't list models; the TTS call
    // below is the real test of the model.
    let ttsModel = config.ttsModel;
    const m = await fetch(`${API}/v1/models`, { headers });
    if (!m.ok) {
        console.log(`models: skipped (HTTP ${m.status}; the key has no models_read permission, which the server doesn't need)`);
    } else {
        const models = await m.json();
        const tts = models.find((x) => x.model_id === config.ttsModel);
        console.log(`models: ${models.length} listed; ${config.ttsModel}: ${tts ? `yes (tts=${tts.can_do_text_to_speech})` : 'NOT LISTED'}`);
        if (!tts?.can_do_text_to_speech) {
            ttsModel = 'eleven_multilingual_v2';
            env.push(`TK_TTS_MODEL=${ttsModel}`);
            console.log(`  falling back to ${ttsModel}`);
        }
    }

    // 2. TTS sample
    const t = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=wav_16000`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'audio/wav' },
        body: JSON.stringify({ text: SAMPLE_TEXT, model_id: ttsModel }),
    });
    if (!t.ok) {
        console.log(`TTS -> HTTP ${t.status} ${await detail(t)}`);
        return 1;
    }
    const wav = Buffer.from(await t.arrayBuffer());
    const samplePath = join(HERE, 'cache', 'probe-sample.wav');
    await mkdir(dirname(samplePath), { recursive: true });
    await writeFile(samplePath, wav);
    console.log(`tts: ${ttsModel}, voice=${config.appVoice ? 'app' : 'device fallback'} -> ${wav.length} bytes, saved cache/probe-sample.wav`);

    // 3. STT attempts, first success wins
    const attempts = [
        { model: config.sttModel, keytermsMode: 'repeat' },
        { model: config.sttModel, keytermsMode: 'json' },
        { model: config.sttModel, keytermsMode: 'none' },
        { model: 'scribe_v1', keytermsMode: 'none' },
    ];
    for (const a of attempts) {
        const form = buildSttForm({ audio: wav, type: 'audio/wav', model: a.model, keyterms: [...BASE_KEYTERMS, 'Henry'], keytermsMode: a.keytermsMode });
        const s = await fetch(`${API}/v1/speech-to-text`, { method: 'POST', headers, body: form });
        if (!s.ok) {
            console.log(`stt: ${a.model} keyterms=${a.keytermsMode} -> HTTP ${s.status} ${await detail(s)}`);
            continue;
        }
        const j = await s.json();
        console.log(`stt: ${a.model} keyterms=${a.keytermsMode} -> 200 "${j.text}" (language ${j.language_code})`);
        if (a.model !== config.sttModel) {
            env.push(`TK_STT_MODEL=${a.model}`);
        }
        if (a.keytermsMode === 'json') {
            env.push('TK_STT_KEYTERMS_MODE=json');
        }
        if (a.keytermsMode === 'none') {
            console.log('  keyterms were refused: the server would need a change (tell Claude)');
        }
        console.log(env.length ? `set in server/.env:\n  ${env.join('\n  ')}` : 'defaults are right: nothing to change');
        return 0;
    }
    console.log('every STT attempt failed');
    return 1;
}

main().then(
    (code) => process.exit(code),
    (e) => {
        console.log(`probe failed: ${e.message}`);
        process.exit(1);
    },
);
