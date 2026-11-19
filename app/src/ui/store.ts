// Small external stores for the UI controllers, read from React with useSyncExternalStore. The app's
// main store (state.ts: connection, server health, log, chat) is read the same way via useAppState.

import { useSyncExternalStore } from 'react';

import { getState, subscribe as subscribeApp, type AppState } from '../state.ts';

export interface Store<T> {
    get(): T;
    set(patch: Partial<T>): void;
    subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(patch) {
            state = { ...state, ...patch };
            for (const fn of listeners) {
                fn();
            }
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
    };
}

export function useStore<T>(store: Store<T>): T {
    return useSyncExternalStore(store.subscribe, store.get);
}

const subscribeAppState = (fn: () => void): (() => void) => {
    const off = subscribeApp(() => fn());
    return () => {
        off();
    };
};

export function useAppState(): AppState {
    return useSyncExternalStore(subscribeAppState, getState);
}

/** The visible status line (announce.ts writes every announcement here too). */
export const statusLine = createStore<{ text: string; level: 'info' | 'alert' }>({ text: '', level: 'info' });

/** Off when the OS asks for less motion: the orb and bubbles then only change color and text. */
export const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
