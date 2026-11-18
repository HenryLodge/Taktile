// WebSocket transport to the simulator (sim/): binary messages carry the same frames as USB serial.
// The sim accepts one app at a time (a new connection replaces the old) and only from localhost pages.

import type { Transport } from './types.ts';

export const SIM_URL = 'ws://localhost:8765';

export class WebSocketTransport implements Transport {
    readonly kind = 'sim' as const;
    private ws: WebSocket | null = null;
    private bytesCb: (b: Uint8Array) => void = () => undefined;
    private closeCb: (reason: string) => void = () => undefined;
    private closing = false;
    private readonly url: string;

    constructor(url: string = SIM_URL) {
        this.url = url;
    }

    onBytes(cb: (b: Uint8Array) => void): void {
        this.bytesCb = cb;
    }

    onClose(cb: (reason: string) => void): void {
        this.closeCb = cb;
    }

    open(): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            ws.binaryType = 'arraybuffer';
            let opened = false;
            ws.onopen = () => {
                opened = true;
                this.ws = ws;
                resolve();
            };
            ws.onmessage = (e: MessageEvent) => {
                if (e.data instanceof ArrayBuffer) {
                    this.bytesCb(new Uint8Array(e.data));
                }
            };
            ws.onclose = () => {
                if (!opened) {
                    reject(new Error(`no simulator at ${this.url} (start taktile-sim)`));
                } else if (!this.closing) {
                    this.closeCb('the simulator closed the connection');
                }
            };
        });
    }

    async write(bytes: Uint8Array): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('simulator not connected');
        }
        this.ws.send(bytes);
    }

    async close(): Promise<void> {
        this.closing = true;
        this.ws?.close();
        this.ws = null;
    }
}
