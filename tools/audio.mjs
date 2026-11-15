// Pure audio helpers for gen-audio.mjs: WAV parse/write, silence trim, peak normalize.
// Clip format (docs/AUDIO.md): 16-bit signed little-endian PCM, mono, 16 kHz.

export const SAMPLE_RATE = 16000;
export const KEEP_SILENCE_MS = 40;
export const SILENCE_DBFS = -45;
export const PEAK_DBFS = -3;

const dbfsToAmplitude = (db) => Math.round(32767 * 10 ** (db / 20));

// Parse a WAV file. Returns Int16Array samples. Throws unless it is PCM, 16-bit, mono, 16 kHz.
export function parseWav(buf) {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('not a WAV file');
    }
    let fmt = null;
    let data = null;
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        let size = buf.readUInt32LE(off + 4);
        const start = off + 8;
        // Streaming encoders sometimes write 0 or 0xFFFFFFFF for the data size: take the rest.
        if (id === 'data' && (size === 0 || size === 0xffffffff || start + size > buf.length)) {
            size = buf.length - start;
        }
        if (start + size > buf.length) {
            throw new Error(`WAV chunk ${id} runs past the end`);
        }
        if (id === 'fmt ') {
            if (size < 16) throw new Error('WAV fmt chunk too short');
            fmt = {
                format: buf.readUInt16LE(start),
                channels: buf.readUInt16LE(start + 2),
                rate: buf.readUInt32LE(start + 4),
                bits: buf.readUInt16LE(start + 14),
            };
        } else if (id === 'data') {
            data = buf.subarray(start, start + size);
            break;
        }
        off = start + size + (size & 1);
    }
    if (!fmt) throw new Error('WAV has no fmt chunk');
    if (!data) throw new Error('WAV has no data chunk');
    if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE) {
        throw new Error(
            `WAV must be PCM 16-bit mono ${SAMPLE_RATE} Hz, got format ${fmt.format}, ${fmt.bits}-bit, ` +
                `${fmt.channels} channel(s), ${fmt.rate} Hz`,
        );
    }
    if (data.length % 2 !== 0) throw new Error('WAV data is not a whole number of 16-bit samples');
    const out = new Int16Array(data.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2);
    return out;
}

export function pcmBytes(samples) {
    const b = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
    return b;
}

export function writeWav(samples) {
    const data = pcmBytes(samples);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + data.length, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // mono
    h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

// Cut leading and trailing silence (below SILENCE_DBFS), keeping KEEP_SILENCE_MS on each side
// (or less where the audio itself is shorter). Throws on all-silent audio.
export function trimSilence(samples, { thresholdDbfs = SILENCE_DBFS, keepMs = KEEP_SILENCE_MS } = {}) {
    const t = dbfsToAmplitude(thresholdDbfs);
    let first = -1;
    let last = -1;
    for (let i = 0; i < samples.length; i++) {
        if (Math.abs(samples[i]) > t) {
            if (first < 0) first = i;
            last = i;
        }
    }
    if (first < 0) throw new Error('clip is silent');
    const keep = Math.round((SAMPLE_RATE * keepMs) / 1000);
    return samples.slice(Math.max(0, first - keep), Math.min(samples.length, last + 1 + keep));
}

// Scale so the loudest sample sits at PEAK_DBFS. Never clips.
export function normalizePeak(samples, peakDbfs = PEAK_DBFS) {
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    if (peak === 0) throw new Error('clip is silent');
    const target = dbfsToAmplitude(peakDbfs);
    const gain = target / peak;
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        out[i] = Math.max(-target, Math.min(target, Math.round(samples[i] * gain)));
    }
    return out;
}

export function peakOf(samples) {
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    return peak;
}

export const peakTarget = () => dbfsToAmplitude(PEAK_DBFS);
