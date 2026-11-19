// Push-to-talk: hold Space (or press the talk button to start and again to stop), speak, release.
// The recording goes to server/ /api/stt (ElevenLabs speech-to-text) and the transcript comes back
// as plain text for the intent parser. A transcript is untrusted input like a typed command.

export const MIN_RECORDING_MS = 400;
export const MAX_RECORDING_MS = 15_000;

export type PttState = 'idle' | 'arming' | 'recording' | 'uploading';

export type VoiceErrorCode = 'mic_blocked' | 'no_mic' | 'too_short' | 'silence' | 'busy' | 'unavailable';

export const VOICE_ERROR_TEXT: Record<VoiceErrorCode, string> = {
    mic_blocked: "Microphone blocked. Allow it in Chrome's site settings, or type the command.",
    no_mic: 'No microphone found. Type the command instead.',
    too_short: 'Hold Space while you speak.',
    silence: "I didn't hear anything. Hold Space and speak.",
    busy: 'Too many requests; wait a few seconds.',
    unavailable: 'Speech service unavailable. Type the command.',
};

export class VoiceError extends Error {
    readonly code: VoiceErrorCode;
    constructor(code: VoiceErrorCode, detail = '') {
        super(detail || VOICE_ERROR_TEXT[code]);
        this.code = code;
    }
}

export interface Recording {
    blob: Blob;
    ms: number;
}

export interface Recorder {
    /** Opens the mic (first time) and starts recording. Throws VoiceError('mic_blocked' | 'no_mic'). */
    start(): Promise<void>;
    stop(): Promise<Recording>;
}

export interface PttDeps {
    recorder: Recorder;
    transcribe: (rec: Recording) => Promise<{ text: string; canned: boolean }>;
    onState: (s: PttState) => void;
    onTranscript: (text: string, canned: boolean) => void;
    onError: (e: VoiceError) => void;
    earcon?: (kind: 'start' | 'stop') => void;
    setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface KeyInfo {
    key: string;
    repeat: boolean;
    /** Focus is in a text field, select or checkbox: Space keeps its normal meaning there. */
    inField: boolean;
}

export class PttController {
    private readonly d: PttDeps;
    private s: PttState = 'idle';
    private releaseWhenArmed = false;
    private cancelTimer: (() => void) | null = null;

    constructor(deps: PttDeps) {
        this.d = deps;
    }

    get state(): PttState {
        return this.s;
    }

    private set(s: PttState): void {
        this.s = s;
        this.d.onState(s);
    }

    async press(): Promise<void> {
        if (this.s !== 'idle') {
            return;
        }
        this.releaseWhenArmed = false;
        this.set('arming');
        try {
            await this.d.recorder.start();
        } catch (e) {
            this.set('idle');
            this.d.onError(e instanceof VoiceError ? e : new VoiceError('no_mic', String(e)));
            return;
        }
        this.set('recording');
        this.d.earcon?.('start');
        const setTimer =
            this.d.setTimer ??
            ((fn, ms) => {
                const t = setTimeout(fn, ms);
                return () => clearTimeout(t);
            });
        this.cancelTimer = setTimer(() => void this.release(), MAX_RECORDING_MS);
        if (this.releaseWhenArmed) {
            await this.release(); // the key came up while the mic was still opening
        }
    }

    async release(): Promise<void> {
        if (this.s === 'arming') {
            this.releaseWhenArmed = true;
            return;
        }
        if (this.s !== 'recording') {
            return;
        }
        this.cancelTimer?.();
        this.cancelTimer = null;
        this.set('uploading');
        this.d.earcon?.('stop');
        try {
            const rec = await this.d.recorder.stop();
            if (rec.ms < MIN_RECORDING_MS) {
                throw new VoiceError('too_short');
            }
            const { text, canned } = await this.d.transcribe(rec);
            if (text.trim() === '') {
                throw new VoiceError('silence');
            }
            this.set('idle');
            this.d.onTranscript(text.trim(), canned);
        } catch (e) {
            this.set('idle');
            this.d.onError(e instanceof VoiceError ? e : new VoiceError('unavailable', String(e)));
        }
    }

    /** The talk button: press to start, press again to stop (screen readers turn Space into a click). */
    async toggle(): Promise<void> {
        if (this.s === 'idle') {
            await this.press();
        } else {
            await this.release();
        }
    }

    /** Returns true when the key was ours (the caller then calls preventDefault). */
    keydown(k: KeyInfo): boolean {
        if (k.key !== ' ' || k.inField) {
            return false;
        }
        if (!k.repeat) {
            void this.press();
        }
        return true;
    }

    keyup(k: KeyInfo): boolean {
        if (k.key !== ' ' || k.inField) {
            return false;
        }
        void this.release();
        return true;
    }
}

/** POST the recording to server/ and map failures to what the user should hear. */
export async function transcribe(
    rec: Recording,
    names: readonly string[],
    fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; canned: boolean }> {
    const q = names.length ? `?names=${encodeURIComponent(names.join(','))}` : '';
    let res: Response;
    try {
        res = await fetchImpl(`/api/stt${q}`, {
            method: 'POST',
            headers: { 'Content-Type': rec.blob.type || 'audio/webm' },
            body: rec.blob,
        });
    } catch {
        throw new VoiceError('unavailable');
    }
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        // not JSON
    }
    const b = body as { text?: unknown; error?: unknown } | null;
    if (!res.ok) {
        if (res.status === 429 || b?.error === 'busy' || b?.error === 'rate_limited') {
            throw new VoiceError('busy');
        }
        if (b?.error === 'too_short') {
            throw new VoiceError('too_short');
        }
        throw new VoiceError('unavailable', `${VOICE_ERROR_TEXT.unavailable} (HTTP ${res.status})`);
    }
    if (typeof b?.text !== 'string') {
        throw new VoiceError('unavailable');
    }
    return { text: b.text, canned: res.headers.get('X-TK-Canned') === '1' };
}

// ---- browser implementation ----

const MIME_CHOICES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];

export class BrowserRecorder implements Recorder {
    private stream: MediaStream | null = null;
    private rec: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private t0 = 0;

    get hasMic(): boolean {
        return this.stream !== null;
    }

    /** The open microphone stream (for the talk orb's level meter), or null before the first use. */
    get micStream(): MediaStream | null {
        return this.stream;
    }

    async openMic(): Promise<void> {
        if (this.stream) {
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new VoiceError('no_mic');
        }
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            const name = (e as { name?: string }).name;
            throw new VoiceError(name === 'NotAllowedError' || name === 'SecurityError' ? 'mic_blocked' : 'no_mic');
        }
    }

    async start(): Promise<void> {
        await this.openMic();
        const stream = this.stream;
        if (!stream) {
            throw new VoiceError('no_mic');
        }
        const mimeType = MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported(m));
        this.chunks = [];
        this.rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        this.rec.ondataavailable = (e) => {
            if (e.data.size > 0) {
                this.chunks.push(e.data);
            }
        };
        this.rec.start();
        this.t0 = performance.now();
    }

    stop(): Promise<Recording> {
        const rec = this.rec;
        if (!rec) {
            return Promise.resolve({ blob: new Blob([]), ms: 0 });
        }
        return new Promise((resolve) => {
            rec.onstop = () => {
                const type = (rec.mimeType || 'audio/webm').split(';')[0] ?? 'audio/webm';
                resolve({ blob: new Blob(this.chunks, { type }), ms: performance.now() - this.t0 });
                this.rec = null;
            };
            rec.stop();
        });
    }
}

let audioCtx: AudioContext | null = null;

/** Short beeps so the user knows recording started (high) and stopped (low). */
export function earcon(kind: 'start' | 'stop'): void {
    try {
        audioCtx ??= new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = kind === 'start' ? 880 : 520;
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.12);
    } catch {
        // no audio output: the live region still says "Listening"
    }
}
