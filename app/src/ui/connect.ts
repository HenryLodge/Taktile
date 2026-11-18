// Connection section: Connect device (USB), Use simulator, Disconnect.

import { connect, disconnect } from '../connection.ts';
import { getState, subscribe } from '../state.ts';
import { grantedPort, webSerialSupported } from '../transport/webserial.ts';
import { el, onPress, setEnabled } from './dom.ts';

export function initConnect(): void {
    const usb = el<HTMLButtonElement>('btn-usb');
    const sim = el<HTMLButtonElement>('btn-sim');
    const off = el<HTMLButtonElement>('btn-disconnect');
    const note = el('usb-note');
    const deviceHeading = el('h-device');
    const supported = webSerialSupported();

    if (!supported) {
        note.hidden = false;
        note.textContent = 'USB needs Chrome or Edge (Web Serial). The simulator works in any browser.';
    } else {
        // A port this browser was already allowed to use: connecting needs no picker.
        void grantedPort().then((p) => {
            if (p !== null) {
                usb.textContent = 'Reconnect device (USB)';
            }
        });
    }

    const go = async (kind: 'usb' | 'sim') => {
        if (await connect(kind)) {
            deviceHeading.focus();
        }
    };
    onPress(usb, () => go('usb'));
    onPress(sim, () => go('sim'));
    onPress(off, async () => {
        const kind = getState().connection.kind;
        await disconnect();
        (kind === 'sim' ? sim : usb).focus();
    });

    // Unplugged or the sim went away: focus goes back to where the user can reconnect.
    document.addEventListener('tk-disconnected', (e) => {
        const kind = (e as CustomEvent<{ kind: string }>).detail.kind;
        (kind === 'sim' ? sim : usb).focus();
    });

    subscribe((s) => {
        const idle = s.connection.status === 'disconnected';
        setEnabled(usb, idle && supported);
        setEnabled(sim, idle);
        setEnabled(off, s.connection.status === 'connected');
    });
}
