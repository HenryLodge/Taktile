// The app's own voice: ElevenLabs text-to-speech through server/ (/api/tts), played on the laptop.
// It is untrusted like everything on the laptop (SECURITY_MODEL); its job is the second channel: it
// speaks the app-side checksum of the bytes the app built, the device speaks its own from the bytes
// it received.
//
// Only important lines are spoken (callers decide). One line plays at a time, and never while the
// device is speaking (mayStart).
// A new normal line drops lines still waiting (speech never lags far behind
// the flow); an interrupt line (errors, refusals) stops the current line and clears the queue. If the
// server can't speak (offline, 429, error) the browser's own voice says the line, so the app never
// goes silent. No retries.

export const MAX_TTS_CHARS = 200;

export interface AudioPlayer {
    /** Plays the clip; resolves when it ends, fails, or stop() is called. */
    play(clip: Blob): Promise<void>;
    stop(): void;
}

export interface FallbackVoice {
    speak(text: string): Promise<void>;
    cancel(): void;
}

export interface SpeakerDeps {
    fetch: typeof fetch;
    player: AudioPlayer;
    fallback: FallbackVoice | null;
    enabled: () => boolean;
    /** false while the device is speaking (a flow is running): lines wait so the two voices never overlap. */
    mayStart?: () => boolean;
    /** How often to re-check mayStart while waiting (ms). */
    gatePollMs?: number;
    /** Called the first time a line falls back to the browser voice (and again after a success). */
    onFallback?: (reason: string) => void;
}

export type Priority = 'normal' | 'interrupt' | 'keep';

interface Item {
    text: string;
    priority: Priority;
    done: () => void;
    cancelled: boolean;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
    'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']; // prettier-ignore
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'];

function below1000(n: number): string[] {
    const out: string[] = [];
    if (n >= 100) {
        out.push(ONES[Math.floor(n / 100)] ?? '', 'hundred');
        n %= 100;
    }
    if (n >= 20) {
        out.push(TENS[Math.floor(n / 10)] ?? '');
        n %= 10;
        if (n > 0) {
            out.push(ONES[n] ?? '');
        }
    } else if (n > 0) {
        out.push(ONES[n] ?? '');
    }
    return out;
}

/** A whole number in English words, read like the device reads it: 1205 -> "one thousand two hundred five". */
export function integerWords(digits: string): string {
    let n = BigInt(digits);
    if (n === 0n) {
        return 'zero';
    }
    const groups: string[] = [];
    for (let scale = 0; n > 0n; scale++) {
        const g = Number(n % 1000n);
        n /= 1000n;
        if (g > 0) {
            groups.unshift([...below1000(g), SCALES[scale] ?? ''].filter(Boolean).join(' '));
        }
    }
    return groups.join(' ');
}

/**
 * Numbers spelled out for the app voice, which mispronounces digits and decimal points ("1.00166624"):
 * "one point zero zero one six six six two four". Digits after the point are read one by one, as the
 * device does. Numbers inside words (addresses like "91Qk") are left alone.
 */
export function numbersToWords(text: string): string {
    return text.replace(/(?<![\w.])(\d+)(?:\.(\d+))?(?![\w])/g, (_m, whole: string, frac: string | undefined) => {
        const w =
            whole.length > 21
                ? whole
                      .split('')
                      .map((d) => ONES[Number(d)])
                      .join(' ')
                : integerWords(whole);
        return frac === undefined
            ? w
            : `${w} point ${frac
                  .split('')
                  .map((d) => ONES[Number(d)])
                  .join(' ')}`;
    });
}

/** Printable ASCII only (the server's rule), common typography mapped, at most 200 characters. */
export function sanitize(text: string): string {
    const s = text
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...')
        .replace(/→/g, ' to ')
        .replace(/[^\x20-\x7e]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length <= MAX_TTS_CHARS) {
        return s;
    }
    const cut = s.slice(0, MAX_TTS_CHARS);
    const space = cut.lastIndexOf(' ');
    return space > MAX_TTS_CHARS / 2 ? cut.slice(0, space) : cut;
}

export class Speaker {
    private readonly d: SpeakerDeps;
    private readonly cache = new Map<string, Blob>();
    private queue: Item[] = [];
    private current: Item | null = null;
    private fellBack = false;

    constructor(deps: SpeakerDeps) {
        this.d = deps;
    }

    /** Queues a line; resolves when it has been spoken, dropped or stopped. */
    speak(text: string, priority: Priority = 'normal'): Promise<void> {
        // Numbers as words; if that would pass the server's 200-character limit (and cut off the end,
        // which may be the checksum words), the line keeps its digits.
        const plain = sanitize(text);
        const worded = sanitize(numbersToWords(plain));
        const clean = numbersToWords(plain).length <= MAX_TTS_CHARS ? worded : plain;
        if (clean === '' || !this.d.enabled()) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const item: Item = { text: clean, priority, done: resolve, cancelled: false };
            if (priority === 'interrupt') {
                this.stop();
            } else {
                // drop waiting normal lines; 'keep' lines (the checksum) are never dropped
                const kept: Item[] = [];
                for (const q of this.queue) {
                    if (q.priority === 'keep') {
                        kept.push(q);
                    } else {
                        q.done();
                    }
                }
                this.queue = kept;
            }
            this.queue.push(item);
            void this.pump();
        });
    }

    /** Speaks a line that must not be dropped and waits for it, but never longer than timeoutMs. */
    speakAndWait(text: string, timeoutMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)));
        return Promise.race([this.speak(text, 'keep'), timeout]).finally(() => clearTimeout(timer));
    }

    /** Stops the current line and drops everything queued. */
    stop(): void {
        for (const q of this.queue) {
            q.cancelled = true;
            q.done();
        }
        this.queue = [];
        if (this.current) {
            this.current.cancelled = true;
            this.d.player.stop();
            this.d.fallback?.cancel();
        }
    }

    get busy(): boolean {
        return this.current !== null || this.queue.length > 0;
    }

    private async pump(): Promise<void> {
        if (this.current !== null) {
            return;
        }
        const item = this.queue.shift();
        if (item === undefined) {
            return;
        }
        this.current = item;
        try {
            while (!item.cancelled && this.d.mayStart && !this.d.mayStart()) {
                await new Promise((r) => setTimeout(r, this.d.gatePollMs ?? 150));
            }
            if (item.cancelled) {
                return;
            }
            const clip = await this.clip(item.text);
            if (!item.cancelled) {
                await this.d.player.play(clip);
            }
            if (this.fellBack) {
                this.fellBack = false;
            }
        } catch (e) {
            if (!item.cancelled && this.d.fallback) {
                if (!this.fellBack) {
                    this.fellBack = true;
                    this.d.onFallback?.(e instanceof Error ? e.message : String(e));
                }
                try {
                    await this.d.fallback.speak(item.text);
                } catch {
                    // nothing else to try; the live region still has the text
                }
            }
        } finally {
            this.current = null;
            item.done();
            void this.pump();
        }
    }

    private async clip(text: string): Promise<Blob> {
        const hit = this.cache.get(text);
        if (hit) {
            return hit;
        }
        const res = await this.d.fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
        if (!res.ok) {
            throw new Error(`speech service HTTP ${res.status}`);
        }
        const blob = await res.blob();
        if (blob.size === 0) {
            throw new Error('speech service returned no audio');
        }
        if (this.cache.size > 300) {
            this.cache.clear();
        }
        this.cache.set(text, blob);
        return blob;
    }
}

// ---- browser implementations ----

export class BrowserPlayer implements AudioPlayer {
    private audio: HTMLAudioElement | null = null;
    private finish: (() => void) | null = null;

    play(clip: Blob): Promise<void> {
        this.stop();
        return new Promise<void>((resolve) => {
            const url = URL.createObjectURL(clip);
            const audio = new Audio(url);
            this.audio = audio;
            const end = () => {
                URL.revokeObjectURL(url);
                if (this.audio === audio) {
                    this.audio = null;
                    this.finish = null;
                }
                resolve();
            };
            this.finish = end;
            audio.onended = end;
            audio.onerror = end;
            audio.play().catch(end);
        });
    }

    stop(): void {
        if (this.audio) {
            this.audio.pause();
        }
        this.finish?.();
    }
}

export function browserFallback(): FallbackVoice | null {
    if (typeof speechSynthesis === 'undefined') {
        return null;
    }
    return {
        speak: (text) =>
            new Promise<void>((resolve) => {
                const u = new SpeechSynthesisUtterance(text);
                u.lang = 'en-US';
                u.onend = () => resolve();
                u.onerror = () => resolve();
                speechSynthesis.speak(u);
            }),
        cancel: () => speechSynthesis.cancel(),
    };
}
