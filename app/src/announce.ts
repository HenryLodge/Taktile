// Announcements, three ways at once: the visible status line, a screen-reader live region (polite for
// status and device events, assertive for errors and refusals), and the app voice (server/ TTS on the
// laptop speaker) only for the important lines, which pass { voice: true }: the intent + checksum,
// the final result, and voice problems (decided 2026-11-18). "Speak with app voice" turns it off.

let politeEl: HTMLElement | null = null;
let assertiveEl: HTMLElement | null = null;
let lineEl: HTMLElement | null = null;
let voice: ((text: string, interrupt: boolean) => void) | null = null;

export function initAnnounce(polite: HTMLElement, assertive: HTMLElement, line: HTMLElement): void {
    politeEl = polite;
    assertiveEl = assertive;
    lineEl = line;
}

/** The app voice; set by main.ts once the speaker exists. */
export function setVoice(fn: (text: string, interrupt: boolean) => void): void {
    voice = fn;
}

function put(el: HTMLElement | null, text: string): void {
    if (lineEl) {
        lineEl.textContent = text;
    }
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
        voice?.(text, false);
    }
}

/** Assertive: errors and refusals; interrupts the screen reader and the app voice. */
export function alertUser(text: string, opts: AnnounceOptions = {}): void {
    put(assertiveEl, text);
    if (opts.voice === true) {
        voice?.(text, true);
    }
}
