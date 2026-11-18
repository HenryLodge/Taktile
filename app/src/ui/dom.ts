// DOM helpers shared by the UI modules.

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
    const e = document.getElementById(id);
    if (e === null) {
        throw new Error(`missing #${id} in index.html`);
    }
    return e as T;
}

/**
 * Buttons are never `disabled`: a disabled button leaves the tab order, so a screen-reader user can't
 * find it or learn why it is off. They get aria-disabled instead, and their handlers check it.
 */
export function setEnabled(button: HTMLButtonElement, enabled: boolean): void {
    button.setAttribute('aria-disabled', String(!enabled));
}

export const isEnabled = (button: HTMLButtonElement): boolean => button.getAttribute('aria-disabled') !== 'true';

export function onPress(button: HTMLButtonElement, fn: () => void | Promise<void>): void {
    button.addEventListener('click', () => {
        if (isEnabled(button)) {
            void fn();
        }
    });
}
