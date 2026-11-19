// "Contacts": the app's own name -> address list, and adding each one to the device. Saving a contact
// here immediately asks the device (CONTACT_ADD), which spells the name, reads the 8-word address
// phrase and asks for PIN + CONFIRM. Rows the device has confirmed show "on the device".

import { alertUser, say } from '../announce.ts';
import { getDevice, refreshContactCount } from '../connection.ts';
import type { AppContact, ContactBook } from '../contacts.ts';
import { runContactAdd, type EnrollReport } from '../enroll.ts';
import { getState, log, setConnection, subscribe } from '../state.ts';
import { el, isEnabled, setEnabled } from './dom.ts';

export function initContacts(book: ContactBook, onChange: () => void): void {
    const list = el<HTMLUListElement>('contact-list');
    const empty = el('contact-empty');
    const form = el<HTMLFormElement>('contact-form');
    const name = el<HTMLInputElement>('contact-name');
    const address = el<HTMLInputElement>('contact-address');
    const error = el('contact-error');
    const submit = el<HTMLButtonElement>('btn-contact-add');
    const status = el('contact-status');
    let enrolling = false;

    const connected = () => {
        const c = getState().connection;
        return c.status === 'connected' && c.deviceState !== null && c.deviceState !== 0;
    };

    const report = (r: EnrollReport) => {
        status.textContent = r.text;
        log(r.level === 'alert' ? 'error' : r.kind === 'device' ? 'device' : 'app', r.text);
        // Only the result is spoken by the app voice; before that the device is the one speaking.
        (r.level === 'alert' ? alertUser : say)(r.text, { voice: r.kind === 'result' });
    };

    async function enroll(c: AppContact): Promise<void> {
        const device = getDevice();
        if (device === null || !connected()) {
            const msg = `Saved in the app. Connect the device to add ${c.name} there.`;
            log('app', msg);
            say(msg);
            return;
        }
        enrolling = true;
        sync();
        setConnection({ activity: `Adding ${c.name}` });
        status.focus();
        const out = await runContactAdd(c, { client: device.client, report, refreshCount: refreshContactCount });
        if (out.onDevice) {
            book.markOnDevice(c.name);
        }
        enrolling = false;
        if (getState().connection.status === 'connected') {
            setConnection({ activity: null });
        }
        render();
        sync();
    }

    const render = () => {
        list.replaceChildren(
            ...book.list().map((c) => {
                const li = document.createElement('li');
                const label = document.createElement('span');
                label.textContent = `${c.name}: `;
                const code = document.createElement('code');
                code.textContent = c.address;
                const where = document.createElement('span');
                where.className = c.onDevice ? 'tag tag-ok' : 'tag';
                where.textContent = c.onDevice ? ' (on the device)' : ' (not on the device yet)';
                li.append(label, code, where, ' ');
                if (!c.onDevice) {
                    const add = document.createElement('button');
                    add.type = 'button';
                    add.className = 'row-add';
                    add.textContent = `Add ${c.name} to device`;
                    add.addEventListener('click', () => {
                        if (isEnabled(add)) {
                            void enroll(c);
                        }
                    });
                    li.append(add, ' ');
                }
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'row-remove';
                remove.textContent = `Remove ${c.name} from the app`;
                remove.addEventListener('click', () => {
                    if (!isEnabled(remove)) {
                        return;
                    }
                    book.remove(c.name);
                    const msg = `Removed ${c.name} from the app contacts. ${c.onDevice ? 'It is still on the device.' : ''}`;
                    log('app', msg);
                    say(msg);
                    render();
                    onChange();
                    name.focus();
                });
                li.append(remove);
                return li;
            }),
        );
        empty.hidden = book.list().length > 0;
        sync();
    };

    const sync = () => {
        const busy = enrolling || (getDevice()?.client.flowRunning ?? false);
        setEnabled(submit, !enrolling);
        for (const b of list.querySelectorAll<HTMLButtonElement>('button.row-add')) {
            setEnabled(b, !busy && connected());
        }
        for (const b of list.querySelectorAll<HTMLButtonElement>('button.row-remove')) {
            setEnabled(b, !enrolling);
        }
    };
    subscribe(sync);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (enrolling) {
            alertUser('Wait for the device to finish adding the current contact.');
            return;
        }
        const problem = book.add(name.value, address.value);
        if (problem !== null) {
            error.textContent = problem;
            const nameProblem = problem.startsWith('Name') || problem.includes('named');
            name.setAttribute('aria-invalid', String(nameProblem));
            address.setAttribute('aria-invalid', String(!nameProblem));
            alertUser(problem);
            (nameProblem ? name : address).focus();
            return;
        }
        const added = book.find(name.value.trim());
        error.textContent = '';
        name.removeAttribute('aria-invalid');
        address.removeAttribute('aria-invalid');
        log('app', `Added ${added?.name ?? ''} to the app contacts.`);
        form.reset();
        render();
        onChange();
        if (added) {
            void enroll(added); // the device asks, announces and confirms
        }
    });

    render();
}
