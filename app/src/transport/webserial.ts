// Web Serial transport to the device's native USB port (USB-Serial-JTAG, vendor 0x303A).
//
// Opening the port never toggles DTR/RTS on purpose: those lines are wired to the chip's reset and
// boot strapping. With ?signals=off the app drives both low right after open (only if the reset
// check in app/README.md shows a reset without it).

import type { Transport } from './types.ts';

export const ESPRESSIF_VID = 0x303a;

export function webSerialSupported(): boolean {
    return typeof navigator !== 'undefined' && navigator.serial !== undefined;
}

/** A port this browser profile was already granted (no prompt), or null. */
export async function grantedPort(): Promise<SerialPort | null> {
    if (!webSerialSupported()) {
        return null;
    }
    const ports = (await navigator.serial?.getPorts()) ?? [];
    return ports.find((p) => p.getInfo().usbVendorId === ESPRESSIF_VID) ?? null;
}

export class WebSerialTransport implements Transport {
    readonly kind = 'usb' as const;
    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private bytesCb: (b: Uint8Array) => void = () => undefined;
    private closeCb: (reason: string) => void = () => undefined;
    private closing = false;
    private ended = false;
    private readonly lowSignals: boolean;
    private readonly onDisconnect = (e: Event): void => {
        if ((e as Event & { target: unknown }).target === this.port) {
            this.end('the USB cable was unplugged');
        }
    };

    constructor({ lowSignals = false }: { lowSignals?: boolean } = {}) {
        this.lowSignals = lowSignals;
    }

    onBytes(cb: (b: Uint8Array) => void): void {
        this.bytesCb = cb;
    }

    onClose(cb: (reason: string) => void): void {
        this.closeCb = cb;
    }

    /** Must be called from a user gesture the first time (the browser shows a port picker). */
    async open(): Promise<void> {
        const serial = navigator.serial;
        if (serial === undefined) {
            throw new Error('Web Serial needs Chrome or Edge');
        }
        const port = (await grantedPort()) ?? (await serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] }));
        try {
            await port.open({ baudRate: 115200 }); // ignored on native USB
        } catch (e) {
            throw new Error(
                `could not open the device port (${(e as Error).message}). Close any serial monitor or script using it.`,
            );
        }
        this.port = port;
        if (this.lowSignals) {
            await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        }
        serial.addEventListener('disconnect', this.onDisconnect);
        void this.readLoop(port);
    }

    async write(bytes: Uint8Array): Promise<void> {
        const w = this.port?.writable;
        if (!w) {
            throw new Error('port not open');
        }
        const writer = w.getWriter();
        try {
            await writer.write(bytes);
        } finally {
            writer.releaseLock();
        }
    }

    async close(): Promise<void> {
        this.closing = true;
        navigator.serial?.removeEventListener('disconnect', this.onDisconnect);
        try {
            await this.reader?.cancel();
        } catch {
            // already gone
        }
        try {
            await this.port?.close();
        } catch {
            // already closed or unplugged
        }
        this.port = null;
        this.ended = true;
    }

    private async readLoop(port: SerialPort): Promise<void> {
        while (port.readable && !this.closing) {
            const reader = port.readable.getReader();
            this.reader = reader;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    if (value && value.length > 0) {
                        this.bytesCb(value);
                    }
                }
            } catch {
                // a non-fatal read error (e.g. a break) leaves port.readable set; loop and keep reading
            } finally {
                reader.releaseLock();
                this.reader = null;
            }
        }
        if (!this.closing) {
            this.end('the device port closed');
        }
    }

    private end(reason: string): void {
        if (this.ended || this.closing) {
            return;
        }
        this.ended = true;
        navigator.serial?.removeEventListener('disconnect', this.onDisconnect);
        this.closeCb(reason);
    }
}
