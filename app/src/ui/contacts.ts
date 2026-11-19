// "App contacts (this laptop only, untrusted)": the name -> address list the send flow uses.

import { alertUser, say } from '../announce.ts';
import type { ContactBook } from '../contacts.ts';
import { log } from '../state.ts';
import { el } from './dom.ts';

export function initContacts(book: ContactBook, onChange: () => void): void {
    const list = el<HTMLUListElement>('contact-list');
    const empty = el('contact-empty');
    const form = el<HTMLFormElement>('contact-form');
    const name = el<HTMLInputElement>('contact-name');
    const address = el<HTMLInputElement>('contact-address');
    const error = el('contact-error');

    const render = () => {
        list.replaceChildren(
            ...book.list().map((c) => {
                const li = document.createElement('li');
                const label = document.createElement('span');
                label.textContent = `${c.name}: `;
                const code = document.createElement('code');
                code.textContent = c.address;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.textContent = `Remove ${c.name}`;
                remove.addEventListener('click', () => {
                    book.remove(c.name);
                    log('app', `Removed ${c.name} from the app contacts.`);
                    say(`Removed ${c.name}.`);
                    render();
                    onChange();
                    name.focus();
                });
                li.append(label, code, ' ', remove);
                return li;
            }),
        );
        empty.hidden = book.list().length > 0;
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const problem = book.add(name.value, address.value);
        if (problem !== null) {
            error.textContent = problem;
            name.setAttribute('aria-invalid', String(problem.startsWith('Name') || problem.includes('named')));
            address.setAttribute('aria-invalid', String(!problem.startsWith('Name') && !problem.includes('named')));
            alertUser(problem);
            (problem.startsWith('Name') || problem.includes('named') ? name : address).focus();
            return;
        }
        const added = name.value.trim();
        error.textContent = '';
        name.removeAttribute('aria-invalid');
        address.removeAttribute('aria-invalid');
        log('app', `Added ${added} to the app contacts (not to the device).`);
        say(`Added ${added} to the app contacts.`);
        form.reset();
        render();
        onChange();
        name.focus();
    });

    render();
}
