// Connecting from the UI: the buttons on /data, and the silent USB reconnect on page load.

import { connect } from '../connection.ts';
import { getState } from '../state.ts';
import { grantedPort, webSerialSupported } from '../transport/webserial.ts';
import { focusTargets } from './focus.ts';
import { route } from './route.ts';

export async function connectFromUi(kind: 'usb' | 'sim'): Promise<void> {
    if ((await connect(kind)) && route.get().view === 'home') {
        focusTargets.talk?.focus(); // voice is the main action once connected
    }
}

/** A port this browser already allowed: connect to it without a picker. Called once at startup. */
export async function autoReconnect(): Promise<void> {
    if (!webSerialSupported() || getState().connection.status !== 'disconnected') {
        return;
    }
    if ((await grantedPort()) !== null) {
        await connectFromUi('usb');
    }
}
