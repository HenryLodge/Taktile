// Elements other modules move focus to (set by the components that render them). Focus moves only to
// an element in the visible view: a hidden element can't take focus.

export const focusTargets: { talk: HTMLElement | null } = { talk: null };

export function focusIfVisible(e: HTMLElement | null | undefined): void {
    if (e && e.offsetParent !== null) {
        e.focus();
    }
}
