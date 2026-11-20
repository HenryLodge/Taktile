#!/usr/bin/env node
// Taktile server: a localhost-only proxy for ElevenLabs Speech-to-Text and Text-to-Speech, so the
// API key never reaches the browser, and the payment-request store (devnet only, never signs). One
// dependency: @solana/web3.js (pinned, as in app/), for devnet reads.
//
//   GET  /api/health  -> { mode, stt, tts }
//   POST /api/stt     raw audio body (audio/webm|ogg|wav|mpeg, <= 1 MB), ?names=A,B -> { text }
//   POST /api/tts     { "text": "..." } (1-200 printable ASCII) -> audio/mpeg
//   GET  /api/agent/token  -> { token } for the ElevenLabs disambiguation agent (WebRTC session)
//   POST /api/requests, GET /api/requests?recipient=|payer=, GET /api/requests/:id -> payment requests
//   GET /actions.json, GET|POST|OPTIONS /api/actions/... -> Solana Actions (public; see lib/actions.mjs)
//
// Run: npm run dev (live) or npm run dev:canned (no ElevenLabs calls). Config: server/.env, see
// .env.example and README.md. The key is never logged, returned, or included in an error.

import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCache } from './lib/cache.mjs';
import { HttpError, hostAllowed, makeRedactor, originAllowed, sendJson } from './lib/http.mjs';
import { createLimiter } from './lib/limits.mjs';
import { ACTIONS_HEADERS, handleActions, isActionsPath, sendActionError } from './lib/actions.mjs';
import { handleAgentToken } from './lib/agent.mjs';
import { createRequestStore, handleCreateRequest, handleGetRequest, handleListRequests } from './lib/requests.mjs';
import { createDevnetRpc } from './lib/solana.mjs';
import { handleStt } from './lib/stt.mjs';
import { handleTts } from './lib/tts.mjs';
import { TIMEOUT_MS } from './lib/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 8787;

export function loadConfig(env, argv = []) {
    const modeEnv = env.TK_SERVER_MODE ?? 'live';
    if (modeEnv !== 'live' && modeEnv !== 'canned') {
        throw new Error(`TK_SERVER_MODE must be "live" or "canned", not "${modeEnv}"`);
    }
    const port = Number(env.TK_SERVER_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`TK_SERVER_PORT is not a port: ${env.TK_SERVER_PORT}`);
    }
    return {
        mode: argv.includes('--canned') ? 'canned' : modeEnv,
        port,
        apiKey: env.ELEVENLABS_API_KEY ?? '',
        voiceId: env.ELEVENLABS_APP_VOICE_ID || env.ELEVENLABS_VOICE_ID || '',
        appVoice: Boolean(env.ELEVENLABS_APP_VOICE_ID),
        sttModel: env.TK_STT_MODEL || 'scribe_v2',
        ttsModel: env.TK_TTS_MODEL || 'eleven_flash_v2_5',
        keytermsMode: env.TK_STT_KEYTERMS_MODE === 'json' ? 'json' : 'repeat',
        cannedTranscript: env.TK_CANNED_TRANSCRIPT || 'send 0.01 SOL to Henry',
        agentId: env.ELEVENLABS_AGENT_ID || '',
        requesterName: (env.TK_REQUESTER_NAME || '').slice(0, 32),
        publicUrl: publicUrl(env.TK_PUBLIC_URL),
    };
}

// TK_PUBLIC_URL: the public base URL of a tunnel to this server (B3), used in Action links and Blink
// URLs. Empty = links use the request's own Host.
function publicUrl(v) {
    if (!v) {
        return '';
    }
    let u;
    try {
        u = new URL(v);
    } catch {
        throw new Error(`TK_PUBLIC_URL is not a URL: ${v}`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error('TK_PUBLIC_URL must be an http(s) URL');
    }
    return `${u.protocol}//${u.host}`;
}

export function health(config) {
    const canned = config.mode === 'canned';
    return {
        mode: config.mode,
        stt: canned || Boolean(config.apiKey),
        tts: canned || Boolean(config.apiKey && config.voiceId),
        agent: !canned && Boolean(config.apiKey && config.agentId),
    };
}

const ROUTES = {
    'POST /api/stt': handleStt,
    'POST /api/tts': handleTts,
    'GET /api/agent/token': handleAgentToken,
    'POST /api/requests': handleCreateRequest,
    'GET /api/requests': handleListRequests,
};

function findRoute(method, path) {
    const exact = ROUTES[`${method} ${path}`];
    if (exact) {
        return exact;
    }
    if (method === 'GET' && path.startsWith('/api/requests/')) {
        return handleGetRequest;
    }
    return undefined;
}

export function createServer({
    config,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    cacheDir = join(HERE, 'cache'),
    log = (line) => console.log(line),
    timeoutMs = TIMEOUT_MS,
    rpc = createDevnetRpc(),
} = {}) {
    const redact = makeRedactor(config.apiKey);
    const safeLog = (line) => log(redact(line));
    const ctx = {
        config,
        fetchImpl,
        timeoutMs,
        redact,
        log: safeLog,
        limiter: createLimiter({ now }),
        cache: createCache(cacheDir),
        state: { sttInFlight: false }, // shared across requests
        rpc,
        requests: createRequestStore({ now, rpc, requesterName: config.requesterName }),
    };

    const server = http.createServer(async (req, res) => {
        const started = Date.now();
        let note = '';
        let path = '?';
        // Logged: method, path, status, size, time and how it was served. Never text, audio or the key.
        res.on('finish', () => {
            const size = res.getHeader('content-length') ?? 0;
            safeLog(`${req.method} ${path} ${res.statusCode} ${size}B ${Date.now() - started}ms${note ? ` ${note}` : ''}`);
        });
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            path = url.pathname;
            if (isActionsPath(path)) {
                // Public Solana Actions: any Origin and Host, their own CORS headers and limit.
                const a = ctx.limiter.take('actions');
                if (!a.ok) {
                    req.resume();
                    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again shortly.', {
                        ...ACTIONS_HEADERS,
                        'Retry-After': String(a.retryAfter),
                    });
                }
                try {
                    return await handleActions(req, res, url, ctx);
                } catch (e) {
                    if (e instanceof HttpError && !res.headersSent) {
                        note = e.code;
                        return sendActionError(res, e.status, e.code, redact(e.message));
                    }
                    if (!res.headersSent) {
                        note = `internal: ${e?.message ?? e}`;
                        return sendActionError(res, 500, 'internal', 'Something went wrong. Try again.');
                    }
                    throw e;
                }
            }
            if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
                req.resume();
                throw new HttpError(403, 'forbidden', 'only pages on localhost may use this server');
            }
            const all = ctx.limiter.take('all');
            if (!all.ok) {
                req.resume();
                throw new HttpError(429, 'rate_limited', 'too many requests', { 'Retry-After': String(all.retryAfter) });
            }
            if (req.method === 'GET' && path === '/api/health') {
                return sendJson(res, 200, health(config));
            }
            const handler = findRoute(req.method, path);
            if (!handler) {
                req.resume();
                throw new HttpError(404, 'not_found', 'no such endpoint');
            }
            await handler(req, res, url, { ...ctx, note: (n) => (note = n) });
        } catch (e) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (e instanceof HttpError) {
                note = e.code;
                sendJson(res, e.status, { error: e.code, message: redact(e.message) }, e.headers);
            } else {
                note = `internal: ${e?.message ?? e}`;
                sendJson(res, 500, { error: 'internal', message: 'internal server error' });
            }
        }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    return server;
}

function main() {
    let config;
    try {
        config = loadConfig(process.env, process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    const h = health(config);
    const server = createServer({ config });
    server.listen(config.port, '127.0.0.1', () => {
        console.log(`taktile-server: http://127.0.0.1:${config.port}  mode=${config.mode}`);
        if (config.mode === 'canned') {
            console.log('CANNED mode: no ElevenLabs calls. STT returns TK_CANNED_TRANSCRIPT; TTS serves the cache or a beep.');
        } else {
            console.log(`stt=${h.stt ? config.sttModel : 'OFF'}  tts=${h.tts ? config.ttsModel : 'OFF'}` +
                `  voice=${config.appVoice ? 'app (ELEVENLABS_APP_VOICE_ID)' : 'device (ELEVENLABS_VOICE_ID fallback)'}`);
            if (!h.stt || !h.tts) {
                console.log('WARNING: set ELEVENLABS_API_KEY and a voice ID in server/.env (see .env.example)');
            }
        }
    });
    server.on('error', (e) => {
        console.error(`taktile-server: ${e.message}`);
        process.exit(1);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
