// "Send": a command, typed or spoken ("send 0.01 SOL to Henry") -> intent -> the send flow on the
// device. Voice transcripts go through exactly the same path (runCommand) and start right away: the
// real approval is the device's announcement, PIN and CONFIRM (decided 2026-11-18). React components
// read the store below; focus moves through the `focus` hooks the components register.

import { alertUser, say } from '../announce.ts';
import { getDevice, unlockStatus } from '../connection.ts';
import type { ContactBook } from '../contacts.ts';
import { chooseContact, startElevenLabsAgent } from '../disambiguate.ts';
import { parseIntent, type Intent } from '../intent.ts';
import { createDevnetRpc, type Rpc } from '../rpc.ts';
import { runSend, type Report, type SendPhase } from '../send.ts';
import type { Speaker } from '../speech.ts';
import { chat, getState, log, setConnection } from '../state.ts';
import { createStore, type Store } from './store.ts';

const AGENT_KEY = 'tk.agent.v1';

export interface SendState {
    /** The command field on /data (voice transcripts and "did you mean" fill it too). */
    command: string;
    running: boolean;
    /** The app is waiting for a spoken (or typed) answer to a question. */
    asking: boolean;
    summary: string;
    phase: SendPhase | null;
    phaseText: string;
    phaseLevel: 'info' | 'alert';
    checksum: string[] | null;
    explorer: string | null;
    agentOn: boolean;
}

export interface SendController {
    store: Store<SendState>;
    runCommand(text: string, source: 'typed' | 'voice'): Promise<void>;
    setCommand(text: string): void;
    setAgent(on: boolean): void;
    readonly acceptsVoice: boolean;
    /** Called after a flow ends; the component that owns the elements registers them. */
    focus: { input: () => void; result: () => void };
    setFocusTargets(t: { input: () => void; result: () => void }): void;
}

function loadAgent(): boolean {
    try {
        return localStorage.getItem(AGENT_KEY) !== 'off';
    } catch {
        return true;
    }
}

const ready = (): boolean => {
    const s = getState().connection;
    return s.status === 'connected' && s.deviceState !== null && s.deviceState !== 0;
};

export function createSendController(book: ContactBook, speaker: Speaker): SendController {
    const store = createStore<SendState>({
        command: '',
        running: false,
        asking: false,
        summary: '',
        phase: null,
        phaseText: '',
        phaseLevel: 'info',
        checksum: null,
        explorer: null,
        agentOn: loadAgent(),
    });
    let rpc: Rpc | null = null;
    let lastDone = '';
    let pendingAnswer: ((text: string | null) => void) | null = null;
    let abortAsk: AbortController | null = null;
    const focus = { input: () => undefined, result: () => undefined } as SendController['focus'];

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
                store.set({ asking: false });
                resolve(null);
            }, timeoutMs);
            pendingAnswer = (text) => {
                clearTimeout(t);
                pendingAnswer = null;
                store.set({ asking: false });
                resolve(text);
            };
            store.set({ asking: true });
        });

    const report = (r: Report): void | Promise<void> => {
        store.set({ phase: r.phase, phaseText: r.text, phaseLevel: r.level });
        log(r.level === 'alert' ? 'error' : r.phase === 'device' ? 'device' : 'app', r.text);
        // The home page conversation gets only the key lines; progress shows as one "working" bubble.
        if (r.phase === 'checksum') {
            chat('taktile', r.text, r.words ? { words: r.words } : {});
            store.set({ checksum: r.words ?? null });
            say(r.text);
            // Spoken in full before SIGN_REQUEST; the flow waits for it (capped in send.ts).
            return speaker.speakAndWait(r.text, 8000);
        }
        if (r.phase === 'failed') {
            chat('taktile', r.text, { level: r.level });
        } else if (r.phase === 'done') {
            lastDone = r.text; // added with the explorer link once runSend returns
        }
        // The app voice says only the outcome; progress stays on screen and in the live region.
        const spoken = r.phase === 'done' || r.phase === 'failed';
        (r.level === 'alert' ? alertUser : say)(r.text, { voice: spoken });
    };

    const finish = () => {
        store.set({ running: false });
        if (getState().connection.status === 'connected') {
            setConnection({ activity: null });
        }
    };

    async function runCommand(raw: string, source: 'typed' | 'voice'): Promise<void> {
        const text = raw.trim();
        if (pendingAnswer) {
            log('app', source === 'voice' ? `Heard: "${text}"` : `Answer: "${text}"`);
            chat('user', text);
            store.set({ command: '' });
            pendingAnswer(text);
            return;
        }
        if (store.get().running) {
            alertUser('Wait for the current send to finish.');
            return;
        }
        if (!ready()) {
            if (text !== '') {
                chat('user', text);
            }
            chat('taktile', 'Connect the device first.', { level: 'alert' });
            alertUser('Connect the device first.');
            return;
        }
        if (source === 'voice') {
            store.set({ command: text });
        }
        if (text === '') {
            alertUser('Say or type a command, for example: send 0.01 SOL to Henry.');
            focus.input();
            return;
        }
        log('app', source === 'voice' ? `Heard: "${text}"` : `Command: "${text}"`);
        chat('user', text);
        let intent: Intent = parseIntent(text, book.list());
        if (intent.kind === 'error') {
            if (intent.code === 'did_you_mean' && intent.suggestion) {
                store.set({ command: text.replace(/to\s+.*$/i, `to ${intent.suggestion.name}`) });
                const msg = `Did you mean ${intent.suggestion.name}? Press Enter to send to ${intent.suggestion.name}.`;
                log('app', msg);
                chat('taktile', msg);
                say(msg, { voice: source === 'voice' });
            } else {
                log('error', intent.message);
                chat('taktile', intent.message, { level: 'alert' });
                if (source === 'voice') {
                    alertUser(`I heard: ${text}. ${intent.message}`, { voice: true });
                } else {
                    alertUser(intent.message);
                }
            }
            focus.input();
            return;
        }
        const device = getDevice();
        if (device === null || device.pubkey === null) {
            alertUser('Connect a device that has a wallet first.');
            return;
        }
        store.set({ running: true, phase: null, phaseText: '', phaseLevel: 'info' });
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
                useAgent: () => store.get().agentOn,
                speaker,
                listenOnce,
                report: (t, level, spoken) => {
                    if (t !== 'Assistant speaking.' && t !== 'Listening for your answer.') {
                        chat('taktile', t, { level });
                    }
                    (level === 'alert' ? alertUser : say)(t, { voice: spoken });
                },
                log: (line) => {
                    log('app', line);
                    // the assistant's conversation turns also go to the home page conversation
                    const turn = /^(Assistant|You): "(.*)"$/.exec(line);
                    if (turn?.[2] !== undefined) {
                        chat(turn[1] === 'You' ? 'user' : 'taktile', turn[2]);
                    }
                },
                signal: abortAsk.signal,
            });
            abortAsk = null;
            if (chosen === null) {
                finish();
                focus.input();
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
            finish();
            return;
        }
        lastDone = '';
        store.set({
            explorer: null,
            checksum: null,
            summary: `Sending ${intent.amountText} ${intent.token} to ${intent.contact.name} (${intent.contact.address}).`,
        });
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
        finish();
        if (result.ok) {
            store.set({ explorer: result.explorer, command: '' });
            log('app', `Explorer: ${result.explorer}`);
            chat('taktile', lastDone || 'Sent.', { link: result.explorer });
            focus.result();
        } else {
            focus.input();
        }
    }

    return {
        store,
        runCommand,
        setCommand: (command) => store.set({ command }),
        setAgent(on) {
            store.set({ agentOn: on });
            try {
                localStorage.setItem(AGENT_KEY, on ? 'on' : 'off');
            } catch {
                // this page only
            }
        },
        get acceptsVoice() {
            return !store.get().running || pendingAnswer !== null;
        },
        focus,
        setFocusTargets(t) {
            focus.input = t.input;
            focus.result = t.result;
        },
    };
}
