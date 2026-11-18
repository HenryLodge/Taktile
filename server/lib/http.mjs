// Small HTTP helpers for server.mjs: errors, body reading with a cap, the localhost-only checks.

export class HttpError extends Error {
    constructor(status, code, message, headers = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
    }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// Browsers send Origin on cross-origin requests and on every POST; tools (curl, probe.mjs) send none.
// Only pages served from this machine may use the proxy, so another site open in the browser can't
// spend ElevenLabs credits (the same rule as sim/).
export function originAllowed(origin) {
    if (origin === undefined) {
        return true;
    }
    let u;
    try {
        u = new URL(origin);
    } catch {
        return false; // includes the opaque "null" origin
    }
    return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
}

// DNS-rebinding guard: a hostile name that resolves to 127.0.0.1 still carries its own Host header.
export function hostAllowed(host) {
    if (typeof host !== 'string') {
        return false;
    }
    const m = /^([^:]+)(?::\d{1,5})?$/.exec(host);
    return m !== null && LOCAL_HOSTS.has(m[1].toLowerCase());
}

// Reads the whole request body; more than `max` bytes is refused with 413.
export function readBody(req, max) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
        req.resume(); // drain and drop
        return Promise.reject(new HttpError(413, 'too_large', `body larger than ${max} bytes`));
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size <= max) {
                chunks.push(c);
            }
        });
        req.on('end', () =>
            size > max
                ? reject(new HttpError(413, 'too_large', `body larger than ${max} bytes`))
                : resolve(Buffer.concat(chunks)),
        );
        req.on('error', reject);
    });
}

export function baseContentType(req) {
    return String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
}

const COMMON = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function sendJson(res, status, obj, headers = {}) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { ...COMMON, 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers });
    res.end(body);
}

export function sendBytes(res, buf, type, headers = {}) {
    res.writeHead(200, { ...COMMON, 'Content-Type': type, 'Content-Length': buf.length, ...headers });
    res.end(buf);
}

// Replaces every occurrence of the secret. Applied to every error message and log line.
export function makeRedactor(secret) {
    if (typeof secret !== 'string' || secret.length < 4) {
        return (s) => String(s);
    }
    return (s) => String(s).split(secret).join('[redacted]');
}
