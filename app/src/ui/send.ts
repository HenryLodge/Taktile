// "Send": a command, typed or spoken ("send 0.01 SOL to Henry") -> intent -> the send flow on the
// device. Voice transcripts go through exactly the same path (runCommand) and start right away: the
// real approval is the device's announcement, PIN and CONFIRM (decided 2026-11-18).

import { alertUser, say } from '../announce.ts';
import { cancelOnDevice, getDevice, unlockStatus } from '../connection.ts';
import type { ContactBook } from '../contacts.ts';
import { chooseContact, startElevenLabsAgent } from '../disambiguate.ts';
import { parseIntent, type Intent } from '../intent.ts';
import { createDevnetRpc, type Rpc } from '../rpc.ts';
import { runSend, type Report } from '../send.ts';
import type { Speaker } from '../speech.ts';
import { getState, log, setConnection, subscribe } from '../state.ts';
import { el, onPress, setEnabled } from './dom.ts';

let rpc: Rpc | null = null;
const AGENT_KEY = 'tk.agent.v1';

export interface SendUi {
    /** Runs a command from the keyboard or from a voice transcript (or answers a pending question). */
    runCommand(text: string, source: 'typed' | 'voice'): Promise<void>;
    readonly running: boolean;
    /** Push-to-talk may record now: idle, or the app is waiting for a spoken answer. */
    readonly acceptsVoice: boolean;
    focusInput(): void;
}

export function initSend(book: ContactBook, speaker: Speaker): SendUi {
    const form = el<HTMLFormElement>('send-form');
    const input = el<HTMLInputElement>('send-command');
    const submit = el<HTMLButtonElement>('btn-send');
    const cancel = el<HTMLButtonElement>('btn-send-cancel');
    const summary = el('send-summary');
    const checksum = el('send-checksum');
    const phase = el('send-phase');
    const link = el<HTMLAnchorElement>('send-link');
    let running = false;
    let pendingAnswer: ((text: string | null) => void) | null = null;
    let abortAsk: AbortController | null = null;
    const agentToggle = el<HTMLInputElement>('agent-toggle');
    try {
        agentToggle.checked = localStorage.getItem(AGENT_KEY) !== 'off';
    } catch {
        agentToggle.checked = true;
    }
    agentToggle.addEventListener('change', () => {
        try {
            localStorage.setItem(AGENT_KEY, agentToggle.checked ? 'on' : 'off');
        } catch {
            // this page only
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && abortAsk) {
            abortAsk.abort();
            pendingAnswer?.(null);
        }
    });

    /** Fallback question: the next push-to-talk (or typed) answer, or null after the timeout. */
    const listenOnce = (timeoutMs: number) =>
        new Promise<string | null>((resolve) => {
            const t = setTimeout(() => {
                pendingAnswer = null;
                resolve(null);
            }, timeoutMs);
            pendingAnswer = (text) => {
                clearTimeout(t);
                pendingAnswer = null;
                resolve(text);
            };
            sync();
            input.focus();
        });

    const ready = () => {
        const s = getState().connection;
        return s.status === 'connected' && s.deviceState !== null && s.deviceState !== 0;
    };
    const sync = () => {
        setEnabled(submit, ready() && !running);
        input.setAttribute('aria-disabled', String(running));
        input.readOnly = running;
        setEnabled(cancel, running);
    };
    subscribe(sync);

    onPress(cancel, cancelOnDevice);

    const report = (r: Report): void | Promise<void> => {
        phase.textContent = r.text;
        log(r.level === 'alert' ? 'error' : r.phase === 'device' ? 'device' : 'app', r.text);
        if (r.phase === 'checksum') {
            // Spoken in full before SIGN_REQUEST; the flow waits for it (capped in send.ts).
            checksum.textContent = r.text;
            say(r.text);
            return speaker.speakAndWait(r.text, 8000);
        }
        // The app voice says only the outcome; progress stays on screen and in the live region.
        const spoken = r.phase === 'done' || r.phase === 'failed';
        (r.level === 'alert' ? alertUser : say)(r.text, { voice: spoken });
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        void runCommand(input.value, 'typed');
    });

    async function runCommand(raw: string, source: 'typed' | 'voice'): Promise<void> {
        if (pendingAnswer) {
            log('app', source === 'voice' ? `Heard: "${raw.trim()}"` : `Answer: "${raw.trim()}"`);
            input.value = '';
            pendingAnswer(raw.trim());
            return;
        }
        if (running) {
            alertUser('Wait for the current send to finish.');
            return;
        }
        if (!ready()) {
            alertUser('Connect the device first.');
            return;
        }
        const text = raw.trim();
        if (source === 'voice') {
            input.value = text;
        }
        if (text === '') {
            alertUser('Say or type a command, for example: send 0.01 SOL to Henry.');
            input.focus();
            return;
        }
        log('app', source === 'voice' ? `Heard: "${text}"` : `Command: "${text}"`);
        let intent: Intent = parseIntent(text, book.list());
        if (intent.kind === 'error') {
            if (intent.code === 'did_you_mean' && intent.suggestion) {
                input.value = text.replace(/to\s+.*$/i, `to ${intent.suggestion.name}`);
                const msg = `Did you mean ${intent.suggestion.name}? Press Enter to send to ${intent.suggestion.name}.`;
                log('app', msg);
                say(msg, { voice: source === 'voice' });
            } else {
                log('error', intent.message);
                if (source === 'voice') {
                    alertUser(`I heard: ${text}. ${intent.message}`, { voice: true });
                } else {
                    alertUser(intent.message);
                }
            }
            input.focus();
            return;
        }
        const device = getDevice();
        if (device === null || device.pubkey === null) {
            alertUser('Connect a device that has a wallet first.');
            return;
        }
        running = true;
        sync();
        if (intent.kind === 'ambiguous') {
            // "Jack" matches several contacts: ask which one (the agent, or the app voice as a fallback).
            log(
                'app',
                `"${intent.spoken}" matches ${intent.candidates.map((c) => c.name).join(' and ')}. Asking which one.`,
            );
            abortAsk = new AbortController();
            const chosen = await chooseContact(intent.candidates, {
                fetch: (i, init) => fetch(i, init),
                startAgent: startElevenLabsAgent,
                useAgent: () => agentToggle.checked,
                speaker,
                listenOnce,
                report: (t, level, spoken) => (level === 'alert' ? alertUser : say)(t, { voice: spoken }),
                log: (line) => log('app', line),
                signal: abortAsk.signal,
            });
            abortAsk = null;
            if (chosen === null) {
                running = false;
                sync();
                input.focus();
                return;
            }
            intent = {
                kind: 'send',
                token: intent.token,
                amount: intent.amount,
                amountText: intent.amountText,
                contact: chosen,
            };
            log('app', `Chosen: ${chosen.name}.`);
        }
        if (intent.kind !== 'send') {
            running = false;
            sync();
            return;
        }
        link.hidden = true;
        checksum.textContent = '';
        summary.textContent = `Sending ${intent.amountText} ${intent.token} to ${intent.contact.name} (${intent.contact.address}).`;
        if (source === 'voice') {
            say(`Heard: ${text}.`);
        }
        setConnection({ activity: 'Sending' });
        rpc ??= createDevnetRpc();
        const result = await runSend(intent, {
            client: device.client,
            pubkey: device.pubkey,
            rpc,
            unlock: async () => {
                const st = await unlockStatus();
                setConnection({ activity: 'Sending' });
                return st;
            },
            report,
        });
        running = false;
        if (getState().connection.status === 'connected') {
            setConnection({ activity: null });
        }
        sync();
        if (result.ok) {
            link.href = result.explorer;
            link.hidden = false;
            log('app', `Explorer: ${result.explorer}`);
            input.value = '';
            link.focus();
        } else {
            input.focus();
        }
    }

    return {
        runCommand,
        get running() {
            return running;
        },
        get acceptsVoice() {
            return !running || pendingAnswer !== null;
        },
        focusInput: () => input.focus(),
    };
}
