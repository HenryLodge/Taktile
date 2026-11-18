// The visible log, "What the app heard (untrusted)": for sighted helpers and judges. It is not a
// live region (the status regions already announce the important lines), so nothing is read twice.

import { DEBUG } from '../connection.ts';
import { subscribe, type LogEntry } from '../state.ts';
import { el } from './dom.ts';

const LABEL: Record<LogEntry['source'], string> = {
    app: 'App',
    device: 'Device',
    error: 'Problem',
    debug: 'Frame',
};

export function initLog(): void {
    const list = el<HTMLOListElement>('log');
    let lastId = 0;
    subscribe(({ log }) => {
        for (const e of log) {
            if (e.id <= lastId || (e.source === 'debug' && !DEBUG)) {
                continue;
            }
            const li = document.createElement('li');
            li.className = `log-${e.source}`;
            const time = document.createElement('time');
            time.dateTime = e.time.toISOString();
            time.textContent = e.time.toLocaleTimeString();
            const who = document.createElement('strong');
            who.textContent = `${LABEL[e.source]}: `;
            li.append(time, ' ', who, e.text);
            list.append(li);
        }
        lastId = log.at(-1)?.id ?? lastId;
        while (list.children.length > 200) {
            list.firstElementChild?.remove();
        }
    });
}
