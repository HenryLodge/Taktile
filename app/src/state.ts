// The app's single store. UI modules subscribe and update only the elements they own.

import type { DeviceState } from './proto/codes.ts';
import type { TransportKind } from './transport/types.ts';

export type LogSource = 'app' | 'device' | 'error' | 'debug';

export interface LogEntry {
    id: number;
    time: Date;
    source: LogSource;
    text: string;
}

/** One bubble on the home page: what the user said, or one of the app's key replies. Untrusted text. */
export interface ChatEntry {
    id: number;
    role: 'user' | 'taktile';
    text: string;
    level: 'info' | 'alert';
    /** Explorer link for a finished send. */
    link?: string;
    /** The app checksum words, shown large next to the sentence. */
    words?: string[];
    /** Text with a Copy button under it (a payment request's Blink link). */
    copy?: { label: string; value: string };
}

export interface ConnectionState {
    status: 'disconnected' | 'connecting' | 'connected';
    kind: TransportKind | null;
    fw: number | null;
    deviceState: DeviceState | null;
    address: string | null;
    contacts: number | null;
    /** What the device is doing for us right now ("Unlocking"), or null when idle. */
    activity: string | null;
}

export type ServerHealth = { mode: 'live' | 'canned'; stt: boolean; tts: boolean } | 'offline' | null;

export interface AppState {
    connection: ConnectionState;
    server: ServerHealth;
    log: LogEntry[];
    chat: ChatEntry[];
}

export const LOG_MAX = 200;
export const CHAT_MAX = 100;

const DISCONNECTED: ConnectionState = {
    status: 'disconnected',
    kind: null,
    fw: null,
    deviceState: null,
    address: null,
    contacts: null,
    activity: null,
};

let state: AppState = { connection: DISCONNECTED, server: null, log: [], chat: [] };
const listeners = new Set<(s: AppState) => void>();
let nextLogId = 1;
let nextChatId = 1;

export const getState = (): AppState => state;

export function subscribe(fn: (s: AppState) => void): () => void {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
}

function emit(): void {
    for (const fn of listeners) {
        fn(state);
    }
}

export function setConnection(patch: Partial<ConnectionState>): void {
    state = { ...state, connection: { ...state.connection, ...patch } };
    emit();
}

export function resetConnection(): void {
    state = { ...state, connection: DISCONNECTED };
    emit();
}

export function setServer(server: ServerHealth): void {
    state = { ...state, server };
    emit();
}

export function log(source: LogSource, text: string): void {
    const entry = { id: nextLogId++, time: new Date(), source, text };
    state = { ...state, log: [...state.log, entry].slice(-LOG_MAX) };
    emit();
}

export function chat(
    role: ChatEntry['role'],
    text: string,
    opts: { level?: ChatEntry['level']; link?: string; words?: string[]; copy?: ChatEntry['copy'] } = {},
): void {
    const entry: ChatEntry = { id: nextChatId++, role, text, level: opts.level ?? 'info' };
    if (opts.link !== undefined) {
        entry.link = opts.link;
    }
    if (opts.words !== undefined) {
        entry.words = opts.words;
    }
    if (opts.copy !== undefined) {
        entry.copy = opts.copy;
    }
    state = { ...state, chat: [...state.chat, entry].slice(-CHAT_MAX) };
    emit();
}
