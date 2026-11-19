// Announcements, three ways at once: the visible status line, a screen-reader live region (polite for
// status and device events, assertive for errors and refusals), and the app voice (server/ TTS on the
// laptop speaker) only for the important lines, which pass { voice: true }: the intent + checksum,
// the final result, and voice problems (decided 2026-11-18). "Speak with app voice" turns it off.

let politeEl: HTMLElement | null = null;
let assertiveEl: HTMLElement | null = null;
let onLine: ((text: string, level: 'info' | 'alert') => void) | null = null;
export type VoicePriority = 'normal' | 'interrupt' | 'keep';
let voice: ((text: string, priority: VoicePriority) => void) | null = null;
/** The last lines given to the app voice, for "repeat that". */
let lastVoiced: string[] = [];

/** The two live regions (static in index.html, outside React) and the visible status line's setter. */
export function initAnnounce(
    polite: HTMLElement,
    assertive: HTMLElement,
    line: (text: string, level: 'info' | 'alert') => void,
): void {
    politeEl = polite;
    assertiveEl = assertive;
    onLine = line;
}

/** The app voice; set by main.ts once the speaker exists. */
export function setVoice(fn: (text: string, priority: VoicePriority) => void): void {
    voice = fn;
}

function put(el: HTMLElement | null, text: string): void {
    onLine?.(text, el === assertiveEl ? 'alert' : 'info');
    if (!el) {
        return;
    }
    // Clear, then set on the next frame, so the same message twice in a row is read again.
    el.textContent = '';
    requestAnimationFrame(() => {
        el.textContent = text;
    });
}

export interface AnnounceOptions {
    /** true: also speak it with the app voice. Default: screen and live region only. */
    voice?: boolean;
}

/** Polite: status and progress. */
export function say(text: string, opts: AnnounceOptions = {}): void {
    put(politeEl, text);
    if (opts.voice === true) {
        lastVoiced = [text];
        voice?.(text, 'normal');
    }
}

/** Assertive: errors and refusals; interrupts the screen reader and the app voice. */
export function alertUser(text: string, opts: AnnounceOptions = {}): void {
    put(assertiveEl, text);
    if (opts.voice === true) {
        lastVoiced = [text];
        voice?.(text, 'interrupt');
    }
}

/**
 * A spoken answer of several lines (a voice query): one polite announcement on screen, and each line
 * queued for the app voice so none is dropped (`say` replaces a waiting line with the next one).
 */
export function sayLines(lines: readonly string[], opts: AnnounceOptions = {}): void {
    if (lines.length === 0) {
        return;
    }
    put(politeEl, lines.join(' '));
    if (opts.voice === true) {
        lastVoiced = [...lines];
        for (const l of lines) {
            voice?.(l, 'keep');
        }
    }
}

/** "Repeat that": the last spoken lines, or an empty list. */
export const lastSpoken = (): readonly string[] => lastVoiced;
