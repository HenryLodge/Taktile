// Connecting to the device (Web Serial) or the simulator (WebSocket), and the quick requests the
// shell offers: HELLO refresh, UNLOCK, CANCEL. Everything the device reports is shown and announced;
// nothing it says is secret (SERIAL_PROTOCOL.md "Forbidden in any frame").

import { alertUser, say } from './announce.ts';
import {
    DeviceClient,
    DeviceProtocolError,
    DisconnectedError,
    FlowBusyError,
    ProtoVersionError,
    RequestTimeoutError,
    type LogRecord,
} from './proto/client.ts';
import {
    DEVICE_STATE,
    PROTO_ERROR,
    STATUS,
    errorName,
    eventText,
    msgName,
    statusName,
    statusText,
    type DeviceState,
} from './proto/codes.ts';
import { base58 } from './proto/base58.ts';
import { getState, log, resetConnection, setConnection } from './state.ts';
import type { Transport, TransportKind } from './transport/types.ts';
import { WebSerialTransport } from './transport/webserial.ts';
import { WebSocketTransport } from './transport/websocket.ts';

const POLL_MS = 15_000;
const params = new URLSearchParams(globalThis.location?.search ?? '');
export const DEBUG = params.get('debug') === '1';

let client: DeviceClient | null = null;
/** Demo builds only (npm run demo): ui/malware.ts wraps every new transport. Identity otherwise. */
let wrapTransport: (t: Transport) => Transport = (t) => t;
export function setTransportWrapper(fn: (t: Transport) => Transport): void {
    wrapTransport = fn;
}
let devicePubkey: Uint8Array | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export const STATE_TEXT: Record<DeviceState, string> = {
    [DEVICE_STATE.NO_WALLET]: 'No wallet (set up the device first)',
    [DEVICE_STATE.LOCKED]: 'Wallet locked',
    [DEVICE_STATE.UNLOCKED]: 'Wallet unlocked',
};

const linkName = (kind: TransportKind | null): string => (kind === 'sim' ? 'the simulator' : 'the device');

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

function logFrame(r: LogRecord): void {
    const arrow = r.dir === 'tx' ? '→' : '←';
    log('debug', `${arrow} ${msgName(r.type)} seq ${r.seq} [${r.payload.length}] ${hex(r.payload).slice(0, 120)}`);
}

/** The live client and the wallet key it reported, for the send flow; null when not connected. */
export function getDevice(): { client: DeviceClient; pubkey: Uint8Array | null } | null {
    return client === null ? null : { client, pubkey: devicePubkey };
}

export function describeError(e: unknown): string {
    if (e instanceof DeviceProtocolError) {
        if (e.code === PROTO_ERROR.UNKNOWN_TYPE) {
            return 'The device firmware does not know this request. Reflash the firmware.';
        }
        return `The device rejected the request (${errorName(e.code)}).`;
    }
    if (e instanceof FlowBusyError) {
        return 'Wait for the current request on the device to finish.';
    }
    if (e instanceof RequestTimeoutError) {
        return `The device did not answer (${e.message}).`;
    }
    if (e instanceof DisconnectedError) {
        return 'Not connected.';
    }
    if (e instanceof Error && e.name === 'NotFoundError') {
        return 'No device was chosen.';
    }
    return e instanceof Error ? e.message : String(e);
}

export async function connect(kind: 'usb' | 'sim'): Promise<boolean> {
    if (client !== null || getState().connection.status === 'connecting') {
        return false;
    }
    setConnection({ status: 'connecting', kind });
    say(`Connecting to ${linkName(kind)}.`);
    const transport = wrapTransport(
        kind === 'usb'
            ? new WebSerialTransport({ lowSignals: params.get('signals') === 'off' })
            : new WebSocketTransport(),
    );
    try {
        await transport.open();
    } catch (e) {
        resetConnection();
        const msg = `Could not connect to ${linkName(kind)}: ${describeError(e)}`;
        log('error', msg);
        alertUser(msg);
        return false;
    }
    const c = new DeviceClient(transport, {
        onFrame: DEBUG ? logFrame : undefined,
        onDecodeError: (r) => log('error', `Bad frame from ${linkName(kind)} (${r.kind}); ignored.`),
    });
    client = c;
    c.onClose((reason) => lost(kind, reason));
    try {
        const h = await c.hello();
        let address: string | null = null;
        if (h.state !== DEVICE_STATE.NO_WALLET) {
            const pk = await c.getPubkey();
            devicePubkey = pk.pubkey;
            address = pk.pubkey ? base58(pk.pubkey) : null;
        }
        const contacts = await c.contactCount();
        setConnection({ status: 'connected', fw: h.fw, deviceState: h.state, address, contacts, activity: null });
        const msg = `Connected to ${linkName(kind)}. ${STATE_TEXT[h.state]}.`;
        log('app', `${msg} Firmware ${h.fw}, protocol ${h.proto}, ${contacts} contact${contacts === 1 ? '' : 's'}.`);
        say(msg);
    } catch (e) {
        const msg =
            e instanceof ProtoVersionError
                ? `Cannot talk to ${linkName(kind)}: ${e.message}. Update the app or the firmware.`
                : `Connected, but ${linkName(kind)} did not answer correctly: ${describeError(e)}`;
        log('error', msg);
        alertUser(msg);
        await disconnect(true);
        return false;
    }
    pollTimer = setInterval(() => void refresh(), POLL_MS);
    return true;
}

function stopPolling(): void {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function lost(kind: TransportKind, reason: string): void {
    if (client === null) {
        return; // we closed it ourselves
    }
    client = null;
    devicePubkey = null;
    stopPolling();
    resetConnection();
    const msg = `${kind === 'sim' ? 'Simulator' : 'Device'} disconnected: ${reason}.`;
    log('error', msg);
    alertUser(msg);
    document.dispatchEvent(new CustomEvent('tk-disconnected', { detail: { kind } }));
}

export async function disconnect(quiet = false): Promise<void> {
    const c = client;
    const kind = getState().connection.kind;
    client = null;
    devicePubkey = null;
    stopPolling();
    if (c !== null) {
        await c.close();
    }
    resetConnection();
    if (!quiet) {
        const msg = `Disconnected from ${linkName(kind)}.`;
        log('app', msg);
        say(msg);
    }
}

/** CONTACT_LIST_COUNT, after a contact was added. */
export async function refreshContactCount(): Promise<void> {
    const c = client;
    if (c === null) {
        return;
    }
    const contacts = await c.contactCount();
    setConnection({ contacts });
}

/** HELLO: keeps the lock state current (the device locks itself after 5 minutes, a signature, ...). */
export async function refresh(): Promise<void> {
    const c = client;
    if (c === null || c.flowRunning) {
        return;
    }
    try {
        const h = await c.hello();
        const before = getState().connection.deviceState;
        if (h.state !== before) {
            setConnection({ deviceState: h.state });
            const msg = `${STATE_TEXT[h.state]}.`;
            log('device', `State changed: ${msg}`);
            say(msg);
        }
    } catch (e) {
        if (!(e instanceof DisconnectedError)) {
            log('error', `Status check failed: ${describeError(e)}`);
        }
    }
}

export async function unlock(): Promise<void> {
    if (getState().connection.deviceState === DEVICE_STATE.UNLOCKED) {
        say('The wallet is already unlocked.');
        return;
    }
    await unlockStatus();
}

/**
 * UNLOCK on the device (the PIN is entered there), announcing each event. Returns the status, or null
 * when the request failed (already reported). Shared by the Unlock button and the send flow.
 */
export async function unlockStatus(): Promise<number | null> {
    const c = client;
    if (c === null) {
        return null;
    }
    setConnection({ activity: 'Unlocking' });
    log('app', 'Asked the device to unlock. Enter your PIN on the device.');
    say('Unlocking. Enter your PIN on the device.');
    try {
        const status = await c.unlock((e) => {
            log('device', eventText(e));
            say(eventText(e));
        });
        if (status === STATUS.OK) {
            log('device', 'Wallet unlocked.');
            say('Wallet unlocked.');
        } else {
            const msg = statusText(status);
            log(status === STATUS.CANCELLED ? 'device' : 'error', `Unlock: ${statusName(status)}. ${msg}`);
            alertUser(msg);
        }
        return status;
    } catch (e) {
        const msg = `Unlock failed: ${describeError(e)}`;
        log('error', msg);
        alertUser(msg);
        return null;
    } finally {
        if (client !== null) {
            setConnection({ activity: null });
            await refresh();
        }
    }
}

export async function cancelOnDevice(): Promise<void> {
    const c = client;
    if (c === null) {
        return;
    }
    try {
        await c.cancel();
        log('app', 'Sent cancel to the device.');
        say('Cancel sent.');
    } catch (e) {
        const msg = `Cancel failed: ${describeError(e)}`;
        log('error', msg);
        alertUser(msg);
    }
}
