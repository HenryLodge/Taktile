// Device section: state, address, firmware, contact count; Unlock and Cancel.

import { alertUser, say } from '../announce.ts';
import { STATE_TEXT, cancelOnDevice, unlock } from '../connection.ts';
import { DEVICE_STATE } from '../proto/codes.ts';
import { subscribe } from '../state.ts';
import { el, onPress, setEnabled } from './dom.ts';

export function initDevice(): void {
    const state = el('dev-state');
    const address = el('dev-address');
    const fw = el('dev-fw');
    const contacts = el('dev-contacts');
    const copy = el<HTMLButtonElement>('btn-copy');
    const unlockBtn = el<HTMLButtonElement>('btn-unlock');
    const cancelBtn = el<HTMLButtonElement>('btn-cancel');

    onPress(unlockBtn, unlock);
    onPress(cancelBtn, cancelOnDevice);
    onPress(copy, async () => {
        const text = address.textContent ?? '';
        try {
            await navigator.clipboard.writeText(text);
            say('Address copied.');
        } catch {
            alertUser('Could not copy. Select the address and copy it.');
        }
    });

    subscribe(({ connection: c }) => {
        const connected = c.status === 'connected';
        const activity = c.activity ? ` (${c.activity})` : '';
        state.textContent =
            c.status === 'connecting'
                ? 'Connecting…'
                : connected && c.deviceState !== null
                  ? `${STATE_TEXT[c.deviceState]}${activity}`
                  : 'Not connected';
        address.textContent = c.address ?? '—';
        fw.textContent = c.fw !== null ? String(c.fw) : '—';
        contacts.textContent = c.contacts !== null ? String(c.contacts) : '—';
        setEnabled(copy, c.address !== null);
        setEnabled(unlockBtn, connected && c.deviceState === DEVICE_STATE.LOCKED && c.activity === null);
        setEnabled(cancelBtn, connected);
    });
}
