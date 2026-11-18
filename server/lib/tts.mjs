// POST /api/tts: { text } -> ElevenLabs Text-to-Speech -> audio/mpeg. Cached on disk.

import { HttpError, readBody, sendBytes } from './http.mjs';
import { toneWav } from './tone.mjs';
import { API, callUpstream } from './upstream.mjs';

export const MAX_TEXT = 200;
export const OUTPUT_FORMAT = 'mp3_22050_32';
export const VOICE_SETTINGS = Object.freeze({ stability: 0.6, similarity_boost: 0.75, style: 0, use_speaker_boost: true });

export function parseText(body) {
    let j;
    try {
        j = JSON.parse(body.toString('utf8'));
    } catch {
        throw new HttpError(400, 'bad_json', 'body must be JSON {"text": "..."}');
    }
    const text = typeof j?.text === 'string' ? j.text.trim() : '';
    if (text.length === 0 || text.length > MAX_TEXT || !/^[\x20-\x7E]+$/.test(text)) {
        throw new HttpError(400, 'bad_text', `text: 1-${MAX_TEXT} printable ASCII characters`);
    }
    return text;
}

export async function handleTts(req, res, _url, ctx) {
    const text = parseText(await readBody(req, 2048));
    const { config } = ctx;
    const k = ctx.cache.key({
        text,
        voice: config.voiceId,
        model: config.ttsModel,
        format: OUTPUT_FORMAT,
        settings: VOICE_SETTINGS,
    });
    const hit = await ctx.cache.get(k);
    const cannedHeader = config.mode === 'canned' ? { 'X-TK-Canned': '1' } : {};
    if (hit) {
        ctx.note('cache');
        return sendBytes(res, hit, 'audio/mpeg', { 'X-TK-Cache': 'hit', ...cannedHeader });
    }
    if (config.mode === 'canned') {
        ctx.note('canned');
        return sendBytes(res, toneWav(), 'audio/wav', cannedHeader);
    }
    if (!config.apiKey || !config.voiceId) {
        throw new HttpError(503, 'no_key', 'ELEVENLABS_API_KEY and a voice ID must be set in server/.env');
    }
    const lim = ctx.limiter.take('tts');
    if (!lim.ok) {
        throw new HttpError(429, 'rate_limited', 'too many speech requests', { 'Retry-After': String(lim.retryAfter) });
    }
    const url = `${API}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=${OUTPUT_FORMAT}`;
    const up = await callUpstream(
        ctx.fetchImpl,
        url,
        {
            method: 'POST',
            headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: config.ttsModel, voice_settings: VOICE_SETTINGS }),
        },
        { kind: 'tts', timeoutMs: ctx.timeoutMs, redact: ctx.redact },
    );
    const audio = Buffer.from(await up.arrayBuffer());
    if (audio.length === 0) {
        throw new HttpError(502, 'upstream_bad_reply', 'ElevenLabs returned no audio');
    }
    try {
        await ctx.cache.put(k, audio);
    } catch (e) {
        ctx.log(`cache write failed: ${e.message}`); // still serve the audio
    }
    ctx.note('upstream');
    return sendBytes(res, audio, 'audio/mpeg', { 'X-TK-Cache': 'miss' });
}
