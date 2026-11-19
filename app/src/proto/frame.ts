// Frame encode + streaming decode (docs/SERIAL_PROTOCOL.md "Frame"). Same rules as
// core/src/tk_proto.c: skip bytes until 0xE5; reject a bad version or CRC and rescan from the byte
// after the rejected magic, so a real frame that began inside a corrupt one is still found; a length
// over 2048 is rejected as soon as the header is in.
//
//   0 magic 0xE5 | 1 version 0x01 | 2 type | 3 seq | 4..5 len u16 LE | payload | crc32 u32 LE

import { crc32 } from './crc32.ts';

export const MAGIC = 0xe5;
export const VERSION = 0x01;
export const HEADER_LEN = 6;
export const CRC_LEN = 4;
export const MAX_PAYLOAD = 2048;

export interface Frame {
    type: number;
    seq: number;
    payload: Uint8Array;
}

export type DecodeResult =
    | ({ kind: 'frame' } & Frame)
    | { kind: 'bad'; seq: number } // bad version or CRC
    | { kind: 'too_large'; seq: number }; // header len > MAX_PAYLOAD

export function encodeFrame(type: number, seq: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (payload.length > MAX_PAYLOAD) {
        throw new RangeError(`payload ${payload.length} bytes > ${MAX_PAYLOAD}`);
    }
    if (!Number.isInteger(type) || type < 0 || type > 0xff || !Number.isInteger(seq) || seq < 0 || seq > 0xff) {
        throw new RangeError('type and seq are bytes');
    }
    const out = new Uint8Array(HEADER_LEN + payload.length + CRC_LEN);
    out[0] = MAGIC;
    out[1] = VERSION;
    out[2] = type;
    out[3] = seq;
    out[4] = payload.length & 0xff;
    out[5] = payload.length >> 8;
    out.set(payload, HEADER_LEN);
    const c = crc32(out, 0, HEADER_LEN + payload.length);
    new DataView(out.buffer).setUint32(HEADER_LEN + payload.length, c, true);
    return out;
}

export class FrameDecoder {
    private buf = new Uint8Array(0);

    /** Feeds bytes; returns every complete result found, in order. */
    push(bytes: Uint8Array): DecodeResult[] {
        const joined = new Uint8Array(this.buf.length + bytes.length);
        joined.set(this.buf, 0);
        joined.set(bytes, this.buf.length);
        const out: DecodeResult[] = [];
        let i = 0;
        for (;;) {
            while (i < joined.length && joined[i] !== MAGIC) {
                i++;
            }
            if (joined.length - i < HEADER_LEN) {
                break;
            }
            const seq = joined[i + 3] ?? 0;
            const len = (joined[i + 4] ?? 0) | ((joined[i + 5] ?? 0) << 8);
            if (joined[i + 1] !== VERSION) {
                out.push({ kind: 'bad', seq });
                i += 1;
                continue;
            }
            if (len > MAX_PAYLOAD) {
                out.push({ kind: 'too_large', seq });
                i += 1;
                continue;
            }
            const total = HEADER_LEN + len + CRC_LEN;
            if (joined.length - i < total) {
                break;
            }
            const want = new DataView(joined.buffer, joined.byteOffset + i + HEADER_LEN + len, CRC_LEN).getUint32(
                0,
                true,
            );
            if (crc32(joined, i, i + HEADER_LEN + len) !== want) {
                out.push({ kind: 'bad', seq });
                i += 1;
                continue;
            }
            out.push({
                kind: 'frame',
                type: joined[i + 2] ?? 0,
                seq,
                payload: joined.slice(i + HEADER_LEN, i + HEADER_LEN + len),
            });
            i += total;
        }
        this.buf = joined.slice(i);
        return out;
    }

    /** Drops a half-received frame (call when the link changes). */
    reset(): void {
        this.buf = new Uint8Array(0);
    }

    get pending(): number {
        return this.buf.length;
    }
}
