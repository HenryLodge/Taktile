// A scripted stand-in for the device, for tests: each step expects one request frame and replays
// canned reply bytes (optionally split into random chunks, to exercise the streaming decoder).

import { FrameDecoder, encodeFrame, type Frame } from '../proto/frame.ts';
import type { Transport } from './types.ts';

export interface MockStep {
    expect: { type: number; payload?: Uint8Array };
    /** Reply frames built from the request (so they can echo its seq). Omit for no reply. */
    reply?: (req: Frame) => Uint8Array[];
    delayMs?: number;
}

/** A reply frame with the request's seq. */
export const reply =
    (type: number, payload: number[] | Uint8Array = []) =>
    (req: Frame): Uint8Array =>
        encodeFrame(type, req.seq, Uint8Array.from(payload));

export class MockTransport implements Transport {
    readonly kind = 'mock' as const;
    readonly written: Frame[] = [];
    readonly errors: string[] = [];
    private readonly steps: MockStep[];
    private readonly decoder = new FrameDecoder();
    private bytesCb: (b: Uint8Array) => void = () => undefined;
    private closeCb: (reason: string) => void = () => undefined;
    private readonly chunked: boolean;
    private rng: number;
    isOpen = false;

    constructor(steps: MockStep[], { chunked = false, seed = 1 } = {}) {
        this.steps = [...steps];
        this.chunked = chunked;
        this.rng = seed;
    }

    onBytes(cb: (b: Uint8Array) => void): void {
        this.bytesCb = cb;
    }

    onClose(cb: (reason: string) => void): void {
        this.closeCb = cb;
    }

    async open(): Promise<void> {
        this.isOpen = true;
    }

    async close(): Promise<void> {
        this.isOpen = false;
    }

    async write(bytes: Uint8Array): Promise<void> {
        for (const r of this.decoder.push(bytes)) {
            if (r.kind !== 'frame') {
                this.errors.push(`app sent a bad frame: ${r.kind}`);
                continue;
            }
            this.written.push(r);
            const step = this.steps.shift();
            if (step === undefined) {
                this.errors.push(`unexpected request type 0x${r.type.toString(16)}`);
                continue;
            }
            if (step.expect.type !== r.type) {
                this.errors.push(`expected type 0x${step.expect.type.toString(16)}, got 0x${r.type.toString(16)}`);
            }
            if (step.expect.payload && !sameBytes(step.expect.payload, r.payload)) {
                this.errors.push(`payload mismatch for type 0x${r.type.toString(16)}`);
            }
            if (step.reply) {
                const frames = step.reply(r);
                setTimeout(() => frames.forEach((f) => this.deliver(f)), step.delayMs ?? 0);
            }
        }
    }

    /** Device -> app bytes outside the script (garbage, unsolicited frames). */
    inject(bytes: Uint8Array): void {
        this.deliver(bytes);
    }

    /** The device goes away (unplugged). */
    remoteClose(reason = 'unplugged'): void {
        this.closeCb(reason);
    }

    get remaining(): number {
        return this.steps.length;
    }

    private deliver(bytes: Uint8Array): void {
        if (!this.chunked) {
            this.bytesCb(bytes);
            return;
        }
        let i = 0;
        while (i < bytes.length) {
            const n = 1 + (this.next() % 7);
            this.bytesCb(bytes.slice(i, i + n));
            i += n;
        }
    }

    private next(): number {
        // xorshift32: deterministic chunk sizes
        let x = this.rng;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.rng = x >>> 0;
        return this.rng;
    }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
