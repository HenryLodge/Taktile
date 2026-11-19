// "My address phrase": the contact's side of enrollment. Anyone enters their own wallet address and
// gets the same 8 words the adding device reads aloud (SHA-256("TK-ADDR-v1" || address), PGP words;
// docs/AUDIO.md). They read the words over the phone; the person adding them compares with the device.
// The phrase is public (SECURITY_MODEL, decided 2026-11-18): it comes from a public address.

import { alertUser, say } from '../announce.ts';
import { addressPhrase } from '../checksum.ts';
import { validAddress } from '../contacts.ts';
import { getDevice } from '../connection.ts';
import type { Speaker } from '../speech.ts';
import { getState, log, subscribe } from '../state.ts';
import { el, onPress, setEnabled } from './dom.ts';
import { PublicKey } from '@solana/web3.js';

export function initPhrase(speaker: Speaker): void {
    const form = el<HTMLFormElement>('phrase-form');
    const input = el<HTMLInputElement>('phrase-address');
    const error = el('phrase-error');
    const useDevice = el<HTMLButtonElement>('btn-phrase-device');
    const words = el<HTMLOListElement>('phrase-words');
    const read = el<HTMLButtonElement>('btn-phrase-read');
    let current: string[] = [];

    subscribe(({ connection }) => {
        setEnabled(useDevice, connection.address !== null);
        setEnabled(read, current.length > 0 && !(getDevice()?.client.flowRunning ?? false));
    });

    onPress(useDevice, () => {
        input.value = getState().connection.address ?? '';
        input.focus();
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        void show();
    });

    async function show(): Promise<void> {
        const a = input.value.trim();
        if (!validAddress(a)) {
            error.textContent = 'Paste a Solana wallet address (base58).';
            input.setAttribute('aria-invalid', 'true');
            alertUser(error.textContent);
            input.focus();
            words.replaceChildren();
            current = [];
            setEnabled(read, false);
            return;
        }
        error.textContent = '';
        input.removeAttribute('aria-invalid');
        current = await addressPhrase(new PublicKey(a).toBytes());
        words.replaceChildren(
            ...current.map((w) => {
                const li = document.createElement('li');
                li.textContent = w;
                return li;
            }),
        );
        setEnabled(read, true);
        const msg = `Address phrase: ${current.join(', ')}.`;
        log('app', `${msg} (for ${a.slice(0, 4)}…${a.slice(-4)})`);
        say(msg);
        read.focus();
    }

    onPress(read, () => {
        if (current.length === 0) {
            return;
        }
        if (getDevice()?.client.flowRunning) {
            alertUser('The device is speaking; read the words when it is done.');
            return;
        }
        void speaker.speak(`Address phrase: ${current.join(', ')}.`, 'interrupt');
    });
}
