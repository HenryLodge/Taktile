// One line saying whether server/ (speech) is reachable: GET /api/health through Vite's proxy.

import { setServer, subscribe, type ServerHealth } from '../state.ts';
import { el } from './dom.ts';

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

export function initServer(): void {
    const line = el('server-line');
    subscribe(({ server: s }) => {
        if (s === null) {
            line.textContent = 'Speech service: checking…';
        } else if (s === 'offline') {
            line.textContent = 'Speech service: offline. Start it with npm run dev in server/.';
        } else if (s.mode === 'canned') {
            line.textContent = 'Speech service: CANNED (no ElevenLabs calls; fixed transcript, beeps for speech).';
        } else {
            line.textContent = `Speech service: live${s.stt && s.tts ? '' : ' but not configured (set the key in server/.env)'}.`;
        }
    });
    void check();
    setInterval(() => void check(), POLL_MS);
}
