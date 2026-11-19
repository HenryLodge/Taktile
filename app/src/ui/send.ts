// "Send": a typed command ("send 0.01 SOL to Henry") -> intent -> the send flow on the device.
// Voice input (M5) will feed the same path.

import { alertUser, say } from '../announce.ts';
import { cancelOnDevice, getDevice, unlockStatus } from '../connection.ts';
import type { ContactBook } from '../contacts.ts';
import { parseIntent } from '../intent.ts';
import { createDevnetRpc, type Rpc } from '../rpc.ts';
import { runSend, type Report } from '../send.ts';
import { getState, log, setConnection, subscribe } from '../state.ts';
import { el, isEnabled, onPress, setEnabled } from './dom.ts';

let rpc: Rpc | null = null;

export function initSend(book: ContactBook): void {
    const form = el<HTMLFormElement>('send-form');
    const input = el<HTMLInputElement>('send-command');
    const submit = el<HTMLButtonElement>('btn-send');
    const cancel = el<HTMLButtonElement>('btn-send-cancel');
    const summary = el('send-summary');
    const checksum = el('send-checksum');
    const phase = el('send-phase');
    const link = el<HTMLAnchorElement>('send-link');
    let running = false;

    const sync = () => {
        const s = getState().connection;
        const ready = s.status === 'connected' && s.deviceState !== null && s.deviceState !== 0;
        setEnabled(submit, ready && !running);
        input.setAttribute('aria-disabled', String(running));
        input.readOnly = running;
        setEnabled(cancel, running);
    };
    subscribe(sync);

    onPress(cancel, cancelOnDevice);

    const report = (r: Report) => {
        phase.textContent = r.text;
        if (r.phase === 'checksum') {
            checksum.textContent = r.text;
        }
        log(r.level === 'alert' ? 'error' : r.phase === 'device' ? 'device' : 'app', r.text);
        (r.level === 'alert' ? alertUser : say)(r.text);
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (running) {
            return;
        }
        if (!isEnabled(submit)) {
            alertUser('Connect the device first.');
            return;
        }
        void send();
    });

    async function send(): Promise<void> {
        const text = input.value.trim();
        if (text === '') {
            alertUser('Type a command, for example: send 0.01 SOL to Henry.');
            input.focus();
            return;
        }
        log('app', `Command: "${text}"`);
        const intent = parseIntent(text, book.list());
        if (intent.kind === 'error') {
            if (intent.code === 'did_you_mean' && intent.suggestion) {
                const fixed = text.replace(/to\s+.*$/i, `to ${intent.suggestion.name}`);
                input.value = fixed;
                const msg = `Did you mean ${intent.suggestion.name}? Press Enter to send to ${intent.suggestion.name}.`;
                log('app', msg);
                say(msg);
            } else {
                log('error', intent.message);
                alertUser(intent.message);
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
        link.hidden = true;
        checksum.textContent = '';
        summary.textContent = `Sending ${intent.amountText} ${intent.token} to ${intent.contact.name} (${intent.contact.address}).`;
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
}
