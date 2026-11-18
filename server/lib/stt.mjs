// POST /api/stt: push-to-talk audio -> ElevenLabs Speech-to-Text -> { text }.
//
// Request: the raw recording as the body (MediaRecorder's audio/webm in the app), at most 1 MB.
// Optional ?names=Henry,Max adds contact names to the recognizer's keyterms. Reply: { text } only.

import { HttpError, baseContentType, readBody, sendJson } from './http.mjs';
import { API, callUpstream } from './upstream.mjs';

export const MAX_AUDIO_BYTES = 1024 * 1024;
export const MIN_AUDIO_BYTES = 1024; // well under the 100 ms ElevenLabs minimum for any real recording
export const MAX_NAMES = 16; // the device's contact book size
export const BASE_KEYTERMS = ['USDC', 'SOL'];

const TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

// The device's contact-name rules (core/src/tk_contacts.c): 1-12 of letters, digits, space, hyphen,
// apostrophe; no leading, trailing or double space.
export function validName(name) {
    return /^[A-Za-z0-9 '-]{1,12}$/.test(name) && !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  ');
}

export function parseNames(param) {
    if (param === null || param === '') {
        return [];
    }
    const names = param.split(',');
    if (names.length > MAX_NAMES || !names.every(validName)) {
        throw new HttpError(400, 'bad_names', `names: up to ${MAX_NAMES} contact names (1-12 letters, digits, space, - or ')`);
    }
    return [...new Set(names)];
}

// keytermsMode: 'repeat' (one form field per term), 'json' (one field holding a JSON array) or 'none'.
export function buildSttForm({ audio, type, model, keyterms, keytermsMode }) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), `ptt.${TYPES[type] ?? 'bin'}`);
    form.append('model_id', model);
    form.append('language_code', 'en');
    form.append('tag_audio_events', 'false');
    if (keytermsMode === 'json') {
        form.append('keyterms', JSON.stringify(keyterms));
    } else if (keytermsMode !== 'none') {
        for (const k of keyterms) {
            form.append('keyterms', k);
        }
    }
    return form;
}

export async function handleStt(req, res, url, ctx) {
    const type = baseContentType(req);
    if (!(type in TYPES)) {
        req.resume();
        throw new HttpError(415, 'bad_type', `Content-Type must be one of ${Object.keys(TYPES).join(', ')}`);
    }
    const names = parseNames(url.searchParams.get('names'));
    const audio = await readBody(req, MAX_AUDIO_BYTES);
    if (audio.length < MIN_AUDIO_BYTES) {
        throw new HttpError(400, 'too_short', 'recording too short: hold the key while you speak');
    }
    const { config } = ctx;
    if (config.mode === 'canned') {
        ctx.note('canned');
        return sendJson(res, 200, { text: config.cannedTranscript }, { 'X-TK-Canned': '1' });
    }
    if (!config.apiKey) {
        throw new HttpError(503, 'no_key', 'ELEVENLABS_API_KEY is not set in server/.env');
    }
    if (ctx.state.sttInFlight) {
        throw new HttpError(429, 'busy', 'another transcription is running', { 'Retry-After': '1' });
    }
    const lim = ctx.limiter.take('stt');
    if (!lim.ok) {
        throw new HttpError(429, 'rate_limited', 'too many transcriptions', { 'Retry-After': String(lim.retryAfter) });
    }
    ctx.state.sttInFlight = true;
    try {
        const form = buildSttForm({
            audio,
            type,
            model: config.sttModel,
            keyterms: [...BASE_KEYTERMS, ...names],
            keytermsMode: config.keytermsMode,
        });
        const up = await callUpstream(
            ctx.fetchImpl,
            `${API}/v1/speech-to-text`,
            { method: 'POST', headers: { 'xi-api-key': config.apiKey }, body: form },
            { kind: 'stt', timeoutMs: ctx.timeoutMs, redact: ctx.redact },
        );
        let reply;
        try {
            reply = await up.json();
        } catch {
            reply = null;
        }
        if (typeof reply?.text !== 'string') {
            throw new HttpError(502, 'upstream_bad_reply', 'ElevenLabs returned no transcript');
        }
        ctx.note('upstream');
        return sendJson(res, 200, { text: reply.text.trim().slice(0, 500) });
    } finally {
        ctx.state.sttInFlight = false;
    }
}
