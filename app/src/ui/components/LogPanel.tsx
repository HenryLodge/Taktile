// The full log, "What the app heard (untrusted)": for sighted helpers and judges. Not a live region
// (the status regions already announce the important lines), so nothing is read twice.

import { useEffect, useRef } from 'react';

import { DEBUG } from '../../connection.ts';
import type { LogEntry } from '../../state.ts';
import { useAppState } from '../store.ts';
import { Panel } from './Panel.tsx';

const LABEL: Record<LogEntry['source'], string> = {
    app: 'App',
    device: 'Device',
    error: 'Problem',
    debug: 'Frame',
};

export function LogPanel() {
    const { log } = useAppState();
    const box = useRef<HTMLDivElement | null>(null);
    const lines = DEBUG ? log : log.filter((e) => e.source !== 'debug');
    const last = lines.at(-1)?.id;

    useEffect(() => {
        const el = box.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [last]);

    return (
        <Panel
            id="sec-log"
            title="What the app heard (untrusted)"
            lead="This laptop can be compromised. Only the device's own voice in your earpiece tells you what you are signing."
        >
            <div ref={box} className="log-box" tabIndex={0} role="region" aria-label="Log">
                <ol className="log">
                    {lines.map((e) => (
                        <li key={e.id} className={`log-${e.source}`}>
                            <time dateTime={e.time.toISOString()}>{e.time.toLocaleTimeString()}</time>
                            <span className="log-src">{LABEL[e.source]}</span>
                            <span className="log-text">{e.text}</span>
                        </li>
                    ))}
                </ol>
            </div>
        </Panel>
    );
}

export function KeysPanel() {
    return (
        <Panel id="sec-keys" title="Keyboard">
            <ul className="keys">
                <li>
                    <kbd>Space</kbd> hold to talk. Works everywhere except in text fields and checkboxes.
                </li>
                <li>
                    <kbd>Enter</kbd> on the talk orb starts listening; <kbd>Enter</kbd> again stops.
                </li>
                <li>
                    <kbd>Esc</kbd> stops the app voice (and cancels a pending question).
                </li>
                <li>
                    <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> move between controls. <kbd>Enter</kbd> presses a
                    button or follows a link.
                </li>
            </ul>
        </Panel>
    );
}
