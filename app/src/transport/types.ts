// A byte pipe to the device (Web Serial) or the simulator (WebSocket). Framing lives above it
// (proto/client.ts), so both carry exactly the same frames.

export type TransportKind = 'usb' | 'sim' | 'mock';

export interface Transport {
    readonly kind: TransportKind;
    open(): Promise<void>;
    close(): Promise<void>;
    write(bytes: Uint8Array): Promise<void>;
    /** Called with every chunk of received bytes. */
    onBytes(cb: (bytes: Uint8Array) => void): void;
    /** Called once when the link ends for any reason other than close(). */
    onClose(cb: (reason: string) => void): void;
}
