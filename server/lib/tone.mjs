// Canned-mode stand-in for TTS audio: a short 440 Hz beep as a WAV, so the app's audio path runs
// without spending credits.

export function toneWav({ ms = 300, hz = 440, rate = 16000 } = {}) {
    const n = Math.round((rate * ms) / 1000);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // fmt chunk size
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28); // byte rate
    buf.writeUInt16LE(2, 32); // block align
    buf.writeUInt16LE(16, 34); // bits per sample
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(n * 2, 40);
    const fade = Math.round(rate / 100); // 10 ms ramps, no clicks
    for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / fade, (n - 1 - i) / fade);
        buf.writeInt16LE(Math.round(0.2 * 32767 * env * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
    }
    return buf;
}
