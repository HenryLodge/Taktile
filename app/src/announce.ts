// Screen-reader announcements: one polite region (status, device events) and one assertive region
// (errors, refusals). The same text is always also shown on screen in the status line.

let politeEl: HTMLElement | null = null;
let assertiveEl: HTMLElement | null = null;
let lineEl: HTMLElement | null = null;

export function initAnnounce(polite: HTMLElement, assertive: HTMLElement, line: HTMLElement): void {
    politeEl = polite;
    assertiveEl = assertive;
    lineEl = line;
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

/** Polite: status and progress. */
export const say = (text: string): void => put(politeEl, text);

/** Assertive: errors and refusals; interrupts the screen reader. */
export const alertUser = (text: string): void => put(assertiveEl, text);
