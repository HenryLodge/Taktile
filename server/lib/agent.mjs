// GET /api/agent/token: a one-conversation token for the ElevenLabs agent that asks "Jack Miller or
// Jack Chen?" (tools/setup-agent.mjs). The browser starts the WebRTC session with this token, so the API
// key never leaves this process. The agent only picks among names the app already parsed.

import { HttpError, sendJson } from './http.mjs';
import { API, callUpstream } from './upstream.mjs';

export async function handleAgentToken(_req, res, _url, ctx) {
    const { config } = ctx;
    if (config.mode === 'canned') {
        throw new HttpError(503, 'canned', 'canned mode: the app asks without the agent');
    }
    if (!config.apiKey) {
        throw new HttpError(503, 'no_key', 'ELEVENLABS_API_KEY is not set in server/.env');
    }
    if (!config.agentId) {
        throw new HttpError(503, 'no_agent', 'ELEVENLABS_AGENT_ID is not set in server/.env (run tools/setup-agent.mjs)');
    }
    const lim = ctx.limiter.take('agent');
    if (!lim.ok) {
        throw new HttpError(429, 'rate_limited', 'too many assistant sessions', { 'Retry-After': String(lim.retryAfter) });
    }
    let up;
    try {
        up = await callUpstream(
            ctx.fetchImpl,
            `${API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(config.agentId)}`,
            { method: 'GET', headers: { 'xi-api-key': config.apiKey } },
            { kind: 'agent', timeoutMs: ctx.timeoutMs, redact: ctx.redact },
        );
    } catch (e) {
        if (e instanceof HttpError && e.code === 'upstream_auth') {
            throw new HttpError(502, 'upstream_auth', 'ElevenLabs refused: the key needs the Agents permission');
        }
        throw e;
    }
    let body = null;
    try {
        body = await up.json();
    } catch {
        // not JSON
    }
    if (typeof body?.token !== 'string' || body.token.length === 0) {
        throw new HttpError(502, 'upstream_bad_reply', 'ElevenLabs returned no conversation token');
    }
    ctx.note('upstream');
    return sendJson(res, 200, { token: body.token });
}
