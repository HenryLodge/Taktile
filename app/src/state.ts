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
}

export const LOG_MAX = 200;

const DISCONNECTED: ConnectionState = {
    status: 'disconnected',
    kind: null,
    fw: null,
    deviceState: null,
    address: null,
    contacts: null,
    activity: null,
};

let state: AppState = { connection: DISCONNECTED, server: null, log: [] };
const listeners = new Set<(s: AppState) => void>();
let nextLogId = 1;

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
