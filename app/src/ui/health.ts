// Whether server/ (speech) is reachable: GET /api/health through Vite's proxy every 30 s.

import { setServer, type ServerHealth } from '../state.ts';

const POLL_MS = 30_000;

function isHealth(j: unknown): j is Exclude<ServerHealth, 'offline' | null> {
    const o = j as { mode?: unknown; stt?: unknown; tts?: unknown } | null;
    return (
        typeof o === 'object' &&
        o !== null &&
        (o.mode === 'live' || o.mode === 'canned') &&
        typeof o.stt === 'boolean' &&
        typeof o.tts === 'boolean'
    );
}

async function check(): Promise<void> {
    try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        const j: unknown = r.ok ? await r.json() : null;
        setServer(isHealth(j) ? j : 'offline');
    } catch {
        setServer('offline');
    }
}

export function startHealthPolling(): void {
    void check();
    setInterval(() => void check(), POLL_MS);
}

export function healthText(s: ServerHealth): string {
    if (s === null) {
        return 'Checking…';
    }
    if (s === 'offline') {
        return 'Offline. Start it with npm run dev in server/.';
    }
    if (s.mode === 'canned') {
        return 'Canned mode (no ElevenLabs calls; fixed transcript, beeps for speech).';
    }
    return s.stt && s.tts ? 'Live.' : 'Live, but not configured (set the key in server/.env).';
}
