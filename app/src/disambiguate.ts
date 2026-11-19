// "Jack Miller or Jack Chen?" When a spoken name matches several contacts (intent.ts 'ambiguous'), the
// app asks which one. First choice: an ElevenLabs agent (a short real-time voice conversation, created
// by tools/setup-agent.mjs). Fallback, whenever the agent can't run: the app voice asks and the next
// push-to-talk answer is matched against the candidates only.
//
// No LLM in the hot path: the agent's only output is one call to the client tool choose_contact, and
// that name is accepted only if it is one of the candidates the deterministic parser produced. The agent
// never sees an amount, token, address or transaction, and the device still announces the recipient
// name it has stored (I3).

import type { AppContact } from './contacts.ts';

export const SESSION_TIMEOUT_MS = 30_000;
export const ANSWER_TIMEOUT_MS = 30_000;

export interface AgentHandlers {
    /** The agent called choose_contact(name). Returns the text sent back to the agent. */
    onChoose: (name: string) => string;
    onMode: (mode: 'speaking' | 'listening') => void;
    onMessage: (text: string, from: 'user' | 'agent') => void;
    onEnd: () => void;
}

export interface AgentSession {
    end(): Promise<void>;
}

export type StartAgent = (
    token: string,
    firstMessage: string,
    prompt: string,
    h: AgentHandlers,
) => Promise<AgentSession>;

export interface DisambiguateDeps {
    fetch: typeof fetch;
    startAgent: StartAgent | null;
    useAgent: () => boolean;
    /** The app voice: stopped before the agent talks; used for the fallback question. */
    speaker: { stop(): void; speakAndWait(text: string, timeoutMs: number): Promise<void> };
    /** Fallback: resolves with the next push-to-talk (or typed) answer, or null on timeout. */
    listenOnce: (timeoutMs: number) => Promise<string | null>;
    report: (text: string, level: 'info' | 'alert', spoken: boolean) => void;
    log: (line: string) => void;
    /** Esc / cancel from the page. */
    signal?: AbortSignal;
    sessionTimeoutMs?: number;
    answerTimeoutMs?: number;
}

export function question(candidates: readonly AppContact[]): string {
    const names = candidates.map((c) => c.name);
    const list =
        names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
    return `Did you mean ${list}?`;
}

/** The whole agent prompt for this session (an override replaces the stored one). */
export function agentPrompt(candidates: readonly AppContact[]): string {
    return [
        'You help a blind user of a hardware wallet pick one person from this list of contacts:',
        ...candidates.map((c) => `- ${c.name}`),
        'Ask which person they mean, in one short question.',
        'When the user picks one, call choose_contact exactly once with that exact name from the list.',
        'Never call choose_contact with a name that is not in the list. If unsure, ask again once.',
        'If the user says cancel, stop, or none of them, say "Cancelled." and do not call choose_contact.',
        'Never mention money, amounts, tokens, addresses or transactions. Keep every reply under 12 words.',
    ].join('\n');
}

const CANCEL = /\b(cancel|stop|none|neither|nobody|no one|never ?mind)\b/;

/**
 * Which candidate does this answer name? Exact full name first, then the words that tell the candidates
 * apart ("Chen"). null when it names none or more than one. "cancel" -> 'cancel'.
 */
export function matchAnswer(answer: string, candidates: readonly AppContact[]): AppContact | 'cancel' | null {
    const a = ` ${answer
        .toLowerCase()
        .replace(/[.,!?;:"]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()} `;
    if (CANCEL.test(a)) {
        return 'cancel';
    }
    const full = candidates.filter((c) => a.includes(` ${c.name.toLowerCase()} `));
    if (full.length === 1 && full[0]) {
        return full[0];
    }
    const words = (c: AppContact) => c.name.toLowerCase().split(' ');
    const shared = candidates.map(words).reduce((acc, w) => acc.filter((x) => w.includes(x)));
    const hits = candidates.filter((c) => words(c).some((w) => !shared.includes(w) && a.includes(` ${w} `)));
    return hits.length === 1 && hits[0] ? hits[0] : null;
}

function exactCandidate(name: string, candidates: readonly AppContact[]): AppContact | null {
    const n = name.trim().toLowerCase();
    return candidates.find((c) => c.name.toLowerCase() === n) ?? null;
}

async function agentToken(d: DisambiguateDeps): Promise<string | null> {
    try {
        const r = await d.fetch('/api/agent/token', { cache: 'no-store' });
        const j = (await r.json().catch(() => null)) as { token?: unknown; error?: unknown; message?: unknown } | null;
        if (r.ok && typeof j?.token === 'string') {
            return j.token;
        }
        d.log(`Assistant unavailable (${typeof j?.error === 'string' ? j.error : `HTTP ${r.status}`}).`);
    } catch {
        d.log('Assistant unavailable (server offline).');
    }
    return null;
}

/** Asks which candidate the user means. Resolves with the chosen contact, or null (cancelled / no answer). */
export async function chooseContact(
    candidates: readonly AppContact[],
    d: DisambiguateDeps,
): Promise<AppContact | null> {
    if (candidates.length < 2) {
        return candidates[0] ?? null;
    }
    if (d.useAgent() && d.startAgent) {
        const token = await agentToken(d);
        if (token !== null) {
            const viaAgent = await withAgent(candidates, token, d.startAgent, d);
            if (viaAgent !== 'unavailable') {
                return viaAgent;
            }
        }
    }
    return fallback(candidates, d);
}

async function withAgent(
    candidates: readonly AppContact[],
    token: string,
    startAgent: StartAgent,
    d: DisambiguateDeps,
): Promise<AppContact | null | 'unavailable'> {
    d.speaker.stop(); // one voice at a time
    let chosen: AppContact | null = null;
    let finish: ((v: AppContact | null) => void) | null = null;
    const done = new Promise<AppContact | null>((r) => (finish = r));
    let session: AgentSession | null = null;
    let ended = false;
    let agentSpeaking = false;
    const end = async (result: AppContact | null) => {
        if (ended) {
            return;
        }
        ended = true;
        clearTimeout(timer);
        d.signal?.removeEventListener('abort', onAbort);
        try {
            await session?.end();
        } catch {
            // already gone
        }
        finish?.(result);
    };
    const timer = setTimeout(() => {
        d.report('No answer. Not sending.', 'alert', true);
        void end(null);
    }, d.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
    const onAbort = () => void end(null);
    d.signal?.addEventListener('abort', onAbort);

    try {
        session = await startAgent(token, question(candidates), agentPrompt(candidates), {
            onChoose: (name) => {
                const c = exactCandidate(name, candidates);
                d.log(`Assistant chose "${name}"${c ? '' : ' (not in the list: refused)'}.`);
                if (!c) {
                    return `"${name}" is not in the list. Ask again which of: ${candidates.map((x) => x.name).join(', ')}.`;
                }
                chosen = c;
                clearTimeout(timer); // a choice was made: the no-answer timeout no longer applies
                // Let the agent finish its short confirmation, then close the session.
                const wait = () => (agentSpeaking ? setTimeout(wait, 150) : void end(c));
                setTimeout(wait, 1200);
                setTimeout(() => void end(c), 5000);
                return `Confirmed. Say only: "OK, ${c.name}."`;
            },
            onMode: (mode) => {
                agentSpeaking = mode === 'speaking';
                d.report(mode === 'speaking' ? 'Assistant speaking.' : 'Listening for your answer.', 'info', false);
            },
            onMessage: (text, from) => {
                d.log(`${from === 'agent' ? 'Assistant' : 'You'}: "${text}"`);
                if (from === 'user' && chosen === null && matchAnswer(text, candidates) === 'cancel') {
                    setTimeout(() => void end(null), 1500);
                }
            },
            onEnd: () => void end(chosen),
        });
    } catch (e) {
        ended = true;
        clearTimeout(timer);
        d.signal?.removeEventListener('abort', onAbort);
        d.log(`Assistant could not start (${e instanceof Error ? e.message : String(e)}).`);
        return 'unavailable';
    }
    if (ended) {
        await session.end().catch(() => undefined); // aborted while starting
    }
    return done;
}

async function fallback(candidates: readonly AppContact[], d: DisambiguateDeps): Promise<AppContact | null> {
    const q = `${question(candidates)} Hold Space and say the name.`;
    d.report(q, 'info', false);
    await d.speaker.speakAndWait(q, 10_000);
    if (d.signal?.aborted) {
        return null;
    }
    const answer = await d.listenOnce(d.answerTimeoutMs ?? ANSWER_TIMEOUT_MS);
    if (answer === null) {
        d.report('No answer. Not sending.', 'alert', true);
        return null;
    }
    d.log(`Answer: "${answer}"`);
    const m = matchAnswer(answer, candidates);
    if (m === 'cancel' || m === null) {
        d.report(m === 'cancel' ? 'Cancelled. Not sending.' : `I heard "${answer}". Not sending.`, 'alert', true);
        return null;
    }
    return m;
}

// ---- browser implementation (ElevenLabs Agents, @elevenlabs/client) ----

export async function startElevenLabsAgent(
    token: string,
    firstMessage: string,
    prompt: string,
    h: AgentHandlers,
): Promise<AgentSession> {
    const { VoiceConversation } = await import('@elevenlabs/client');
    const conv = await VoiceConversation.startSession({
        conversationToken: token,
        connectionType: 'webrtc',
        overrides: { agent: { firstMessage, prompt: { prompt } } },
        clientTools: {
            choose_contact: (params: unknown) => {
                const name = (params as { name?: unknown } | null)?.name;
                return h.onChoose(typeof name === 'string' ? name : '');
            },
        },
        onModeChange: ({ mode }) => h.onMode(mode === 'speaking' ? 'speaking' : 'listening'),
        onMessage: (m) => h.onMessage(m.message, m.source === 'ai' ? 'agent' : 'user'),
        onDisconnect: () => h.onEnd(),
        onError: () => h.onEnd(),
    });
    return { end: () => conv.endSession() };
}
