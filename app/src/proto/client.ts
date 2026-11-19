// Request/response client for the serial protocol (docs/SERIAL_PROTOCOL.md) over any Transport.
//
// - seq 1..255, wrapping; replies and EVENTs are paired with their request by seq.
// - At most one on-device flow (SETUP, UNLOCK, SIGN_REQUEST, CONTACT_ADD, CONTACT_REMOVE, SPEAK_ADDRESS,
//   SPEAK_CONTACTS, LOCK) at a time; a
//   second one is refused here and nothing is sent. Quick requests (HELLO, CANCEL, ...) may go
//   alongside: the device answers HELLO during a flow, acts on CANCEL, and replies BUSY to the rest.
// - A flow that outlives its timeout is cancelled on the device.
// - The device's replies are untrusted input: lengths are checked before any field is read.

import { DEVICE_STATE, FLOW_TYPES, MSG, PROTO_VERSION, RESPONSE_BIT, STATUS, type DeviceState } from './codes.ts';
import { FrameDecoder, encodeFrame, type DecodeResult } from './frame.ts';
import type { Transport } from '../transport/types.ts';

export class DeviceProtocolError extends Error {
    readonly code: number;
    constructor(code: number) {
        super(`device ERROR 0x${code.toString(16).padStart(2, '0')}`);
        this.code = code;
    }
}
export class DisconnectedError extends Error {}
export class RequestTimeoutError extends Error {}
export class FlowBusyError extends Error {}
export class BadReplyError extends Error {}
export class ProtoVersionError extends Error {}
export class BadNameError extends Error {}

export interface LogRecord {
    dir: 'tx' | 'rx';
    type: number;
    seq: number;
    payload: Uint8Array;
}

export interface ClientOptions {
    onFrame?: (rec: LogRecord) => void;
    onDecodeError?: (r: Exclude<DecodeResult, { kind: 'frame' }>) => void;
    quickTimeoutMs?: number;
    flowTimeoutMs?: number;
    setupTimeoutMs?: number;
    idleResetMs?: number;
}

export interface RequestOptions {
    timeoutMs?: number;
    onEvent?: (event: number) => void;
}

interface Pending {
    type: number;
    resolve: (payload: Uint8Array) => void;
    reject: (e: Error) => void;
    onEvent: ((event: number) => void) | undefined;
    timer: ReturnType<typeof setTimeout>;
}

export interface Hello {
    fw: number;
    proto: number;
    state: DeviceState;
}

export class DeviceClient {
    private readonly transport: Transport;
    private readonly opts: Required<Omit<ClientOptions, 'onFrame' | 'onDecodeError'>> & ClientOptions;
    private readonly decoder = new FrameDecoder();
    private readonly pending = new Map<number, Pending>();
    private seq = 0;
    private flowSeq: number | null = null;
    private closed = false;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private closeListeners: ((reason: string) => void)[] = [];

    constructor(transport: Transport, opts: ClientOptions = {}) {
        this.transport = transport;
        this.opts = {
            quickTimeoutMs: 3000,
            flowTimeoutMs: 6 * 60_000,
            setupTimeoutMs: 16 * 60_000,
            idleResetMs: 1000,
            ...opts,
        };
        transport.onBytes((b) => this.feed(b));
        transport.onClose((reason) => this.shutdown(reason));
    }

    get flowRunning(): boolean {
        return this.flowSeq !== null;
    }

    onClose(cb: (reason: string) => void): void {
        this.closeListeners.push(cb);
    }

    async request(type: number, payload: Uint8Array = new Uint8Array(0), ro: RequestOptions = {}): Promise<Uint8Array> {
        if (this.closed) {
            throw new DisconnectedError('not connected');
        }
        const isFlow = FLOW_TYPES.has(type);
        if (isFlow && this.flowSeq !== null) {
            throw new FlowBusyError('another device flow is running');
        }
        const seq = this.nextSeq();
        const frame = encodeFrame(type, seq, payload);
        const timeoutMs =
            ro.timeoutMs ??
            (type === MSG.SETUP
                ? this.opts.setupTimeoutMs
                : isFlow
                  ? this.opts.flowTimeoutMs
                  : this.opts.quickTimeoutMs);
        const result = new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.settle(seq);
                if (isFlow) {
                    void this.cancel().catch(() => undefined);
                }
                reject(new RequestTimeoutError(`no reply within ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            this.pending.set(seq, { type, resolve, reject, onEvent: ro.onEvent, timer });
        });
        if (isFlow) {
            this.flowSeq = seq;
        }
        this.opts.onFrame?.({ dir: 'tx', type, seq, payload });
        try {
            await this.transport.write(frame);
        } catch (e) {
            const p = this.settle(seq);
            p?.reject(new DisconnectedError(`write failed: ${(e as Error).message}`));
        }
        return result;
    }

    // ---- typed requests ----

    async hello(): Promise<Hello> {
        const p = await this.request(MSG.HELLO);
        if (p.length !== 4) {
            throw new BadReplyError(`HELLO reply is ${p.length} bytes, not 4`);
        }
        const fw = (p[0] ?? 0) | ((p[1] ?? 0) << 8);
        const proto = p[2] ?? 0;
        const state = p[3] ?? 0;
        if (proto !== PROTO_VERSION) {
            throw new ProtoVersionError(`device speaks protocol ${proto}, the app speaks ${PROTO_VERSION}`);
        }
        if (state !== DEVICE_STATE.NO_WALLET && state !== DEVICE_STATE.LOCKED && state !== DEVICE_STATE.UNLOCKED) {
            throw new BadReplyError(`HELLO state ${state} is not 0, 1 or 2`);
        }
        return { fw, proto, state };
    }

    /** The wallet's public key, or null when the device has no wallet. */
    async getPubkey(): Promise<{ status: number; pubkey: Uint8Array | null }> {
        const p = await this.request(MSG.GET_PUBKEY);
        const status = this.status(p, 'GET_PUBKEY', p[0] === STATUS.OK ? 33 : 1);
        return { status, pubkey: status === STATUS.OK ? p.slice(1, 33) : null };
    }

    async unlock(onEvent?: (event: number) => void): Promise<number> {
        return this.status(await this.request(MSG.UNLOCK, undefined, { onEvent }), 'UNLOCK', 1);
    }

    /** SIGN_REQUEST with the legacy message bytes. OK carries the 64-byte Ed25519 signature. */
    async signRequest(
        message: Uint8Array,
        onEvent?: (event: number) => void,
    ): Promise<{ status: number; signature: Uint8Array | null }> {
        const p = await this.request(MSG.SIGN_REQUEST, message, { onEvent });
        const status = this.status(p, 'SIGN_REQUEST', p[0] === STATUS.OK ? 65 : 1);
        return { status, signature: status === STATUS.OK ? p.slice(1, 65) : null };
    }

    /**
     * CONTACT_ADD: name_len u8 | name (ASCII) | wallet[32] (SERIAL_PROTOCOL.md). The device spells the
     * name and reads the 8-word address phrase itself, then asks for PIN (if locked) and CONFIRM.
     */
    async contactAdd(name: string, wallet: Uint8Array, onEvent?: (event: number) => void): Promise<number> {
        if (!/^[A-Za-z0-9 '-]{1,12}$/.test(name) || name.startsWith(' ') || name.endsWith(' ') || name.includes('  ')) {
            throw new BadNameError(`not a device contact name: ${JSON.stringify(name)}`);
        }
        if (wallet.length !== 32) {
            throw new BadNameError('wallet must be 32 bytes');
        }
        const payload = new Uint8Array(1 + name.length + 32);
        payload[0] = name.length;
        for (let i = 0; i < name.length; i++) {
            payload[1 + i] = name.charCodeAt(i);
        }
        payload.set(wallet, 1 + name.length);
        return this.status(await this.request(MSG.CONTACT_ADD, payload, { onEvent }), 'CONTACT_ADD', 1);
    }

    /** SPEAK_ADDRESS: the device speaks its own 8-word address phrase (PIN first if locked). Status only. */
    async speakAddress(onEvent?: (event: number) => void): Promise<number> {
        return this.status(await this.request(MSG.SPEAK_ADDRESS, undefined, { onEvent }), 'SPEAK_ADDRESS', 1);
    }

    /** SPEAK_CONTACTS: the device spells its contact names. The reply is the status and the count, never names. */
    async speakContacts(onEvent?: (event: number) => void): Promise<{ status: number; count: number }> {
        const p = await this.request(MSG.SPEAK_CONTACTS, undefined, { onEvent });
        if (p.length !== 2) {
            throw new BadReplyError(`SPEAK_CONTACTS reply is ${p.length} bytes, not 2`);
        }
        return { status: p[0] ?? 0, count: p[1] ?? 0 };
    }

    /** LOCK: end the unlocked session now. Answered within a second ("wallet locked"). */
    async lock(): Promise<number> {
        return this.status(await this.request(MSG.LOCK, undefined, { timeoutMs: 10_000 }), 'LOCK', 1);
    }

    async contactCount(): Promise<number> {
        const p = await this.request(MSG.CONTACT_LIST_COUNT);
        if (p.length !== 1) {
            throw new BadReplyError(`CONTACT_LIST_COUNT reply is ${p.length} bytes, not 1`);
        }
        return p[0] ?? 0;
    }

    async cancel(): Promise<number> {
        return this.status(await this.request(MSG.CANCEL), 'CANCEL', 1);
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.shutdown('closed by the app');
        await this.transport.close();
    }

    // ---- internals ----

    private status(p: Uint8Array, what: string, wantLen: number): number {
        if (p.length !== wantLen) {
            throw new BadReplyError(`${what} reply is ${p.length} bytes, not ${wantLen}`);
        }
        return p[0] ?? 0;
    }

    private nextSeq(): number {
        for (let i = 0; i < 255; i++) {
            this.seq = (this.seq % 255) + 1;
            if (!this.pending.has(this.seq)) {
                return this.seq;
            }
        }
        throw new Error('255 requests in flight');
    }

    private settle(seq: number): Pending | undefined {
        const p = this.pending.get(seq);
        if (p !== undefined) {
            clearTimeout(p.timer);
            this.pending.delete(seq);
        }
        if (this.flowSeq === seq) {
            this.flowSeq = null;
        }
        return p;
    }

    private feed(bytes: Uint8Array): void {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        for (const r of this.decoder.push(bytes)) {
            if (r.kind !== 'frame') {
                this.opts.onDecodeError?.(r);
                continue;
            }
            this.opts.onFrame?.({ dir: 'rx', type: r.type, seq: r.seq, payload: r.payload });
            this.dispatch(r.type, r.seq, r.payload);
        }
        if (this.decoder.pending > 0 && !this.closed) {
            // A half frame that never completes (corrupt length) must not hold up later replies.
            this.idleTimer = setTimeout(() => this.decoder.reset(), this.opts.idleResetMs);
        }
    }

    private dispatch(type: number, seq: number, payload: Uint8Array): void {
        const p = this.pending.get(seq);
        if (p === undefined) {
            return; // unsolicited or late: already logged
        }
        if (type === MSG.EVENT) {
            if (payload.length === 1) {
                p.onEvent?.(payload[0] ?? 0);
            }
            return;
        }
        if (type === MSG.ERROR) {
            this.settle(seq);
            p.reject(new DeviceProtocolError(payload[0] ?? 0));
            return;
        }
        if (type === (p.type | RESPONSE_BIT)) {
            this.settle(seq);
            p.resolve(payload);
        }
    }

    private shutdown(reason: string): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
        }
        for (const seq of [...this.pending.keys()]) {
            this.settle(seq)?.reject(new DisconnectedError(reason));
        }
        for (const cb of this.closeListeners) {
            cb(reason);
        }
    }
}
