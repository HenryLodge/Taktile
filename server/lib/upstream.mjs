// The one place that calls ElevenLabs. No retries: a retry loop is exactly what burns credits.

import { HttpError } from './http.mjs';

export const API = 'https://api.elevenlabs.io';
export const TIMEOUT_MS = 15_000;

function upstreamMessage(text) {
    try {
        const j = JSON.parse(text);
        const d = j?.detail;
        const m = typeof d === 'string' ? d : typeof d?.message === 'string' ? d.message : j?.message;
        if (typeof m === 'string') {
            return m.slice(0, 200);
        }
    } catch {
        // not JSON
    }
    return '';
}

// kind: 'stt' or 'tts'. Returns the Response on 2xx; otherwise throws an HttpError whose message is
// safe to show (redacted).
export async function callUpstream(fetchImpl, url, init, { kind, timeoutMs = TIMEOUT_MS, redact }) {
    let res;
    try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new HttpError(504, 'upstream_timeout', `ElevenLabs did not answer within ${timeoutMs / 1000} s`);
        }
        throw new HttpError(502, 'upstream_unreachable', 'could not reach ElevenLabs');
    }
    if (res.ok) {
        return res;
    }
    let detail = '';
    try {
        detail = redact(upstreamMessage(await res.text()));
    } catch {
        // body unreadable; the status is enough
    }
    const s = res.status;
    if (s === 401 || s === 403) {
        throw new HttpError(502, 'upstream_auth', 'ElevenLabs refused the key: check ELEVENLABS_API_KEY in server/.env');
    }
    if (s === 404 && kind === 'tts') {
        throw new HttpError(
            502,
            'upstream_voice',
            'ElevenLabs has no such voice: check ELEVENLABS_APP_VOICE_ID / ELEVENLABS_VOICE_ID in server/.env',
        );
    }
    if (s === 429) {
        const ra = Number(res.headers.get('retry-after'));
        throw new HttpError(503, 'upstream_busy', 'ElevenLabs is rate-limiting or out of credits', {
            'Retry-After': String(Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 5),
        });
    }
    if (s === 400 || s === 422) {
        throw new HttpError(502, 'upstream_rejected', `ElevenLabs rejected the request${detail ? `: ${detail}` : ''}`);
    }
    throw new HttpError(502, 'upstream_error', `ElevenLabs returned HTTP ${s}`);
}
