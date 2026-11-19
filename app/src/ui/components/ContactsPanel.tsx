// "Contacts": the app's own name -> address list, and adding each one to the device. Saving a contact
// here immediately asks the device (CONTACT_ADD), which spells the name, reads the 8-word address
// phrase and asks for PIN + CONFIRM. Rows the device has confirmed show "On the device".

import { useReducer, useRef, useState } from 'react';

import { alertUser, say } from '../../announce.ts';
import { getDevice, refreshContactCount } from '../../connection.ts';
import type { AppContact } from '../../contacts.ts';
import { runContactAdd, type EnrollReport } from '../../enroll.ts';
import { getState, log, setConnection } from '../../state.ts';
import { useControllers } from '../context.ts';
import { useAppState } from '../store.ts';
import { Button } from './Button.tsx';
import { Panel } from './Panel.tsx';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;

const connected = () => {
    const c = getState().connection;
    return c.status === 'connected' && c.deviceState !== null && c.deviceState !== 0;
};

export function ContactsPanel() {
    const { book } = useControllers();
    useAppState(); // re-render on connection changes (row buttons depend on them)
    const [, bump] = useReducer((x: number) => x + 1, 0);
    const [enrolling, setEnrolling] = useState(false);
    const [status, setStatus] = useState('');
    const [name, setName] = useState('');
    const [address, setAddress] = useState('');
    const [error, setError] = useState<{ text: string; field: 'name' | 'address' } | null>(null);
    const nameRef = useRef<HTMLInputElement | null>(null);
    const addressRef = useRef<HTMLInputElement | null>(null);
    const statusRef = useRef<HTMLParagraphElement | null>(null);

    const report = (r: EnrollReport) => {
        setStatus(r.text);
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
            setStatus(msg);
            return;
        }
        setEnrolling(true);
        setConnection({ activity: `Adding ${c.name}` });
        statusRef.current?.focus();
        const out = await runContactAdd(c, { client: device.client, report, refreshCount: refreshContactCount });
        if (out.onDevice) {
            book.markOnDevice(c.name);
        }
        setEnrolling(false);
        if (getState().connection.status === 'connected') {
            setConnection({ activity: null });
        }
        bump();
    }

    const busy = enrolling || (getDevice()?.client.flowRunning ?? false);
    const contacts = book.list();

    return (
        <Panel
            id="sec-contacts"
            title="Contacts"
            lead="Adding a contact here asks the device to add it: the device spells the name and reads an 8-word address phrase. Check the words with the contact over the phone (they read theirs under My address phrase), then confirm on the device. This list is untrusted; the device checks every recipient against its own contact book."
            aside={<span className="chip">{contacts.length} in the app</span>}
        >
            <p ref={statusRef} className="status-sub" tabIndex={-1}>
                {status}
            </p>
            {contacts.length === 0 ? (
                <p className="empty">No app contacts yet.</p>
            ) : (
                <ul className="contact-list">
                    {contacts.map((c) => (
                        <li key={c.name} className="contact">
                            <span className="avatar" aria-hidden="true">
                                {c.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="contact-main">
                                <span className="contact-name">{c.name}</span>
                                <code className="contact-addr" title={c.address}>
                                    <span aria-hidden="true">{short(c.address)}</span>
                                    <span className="sr-only">{c.address}</span>
                                </code>
                            </span>
                            <span className={c.onDevice ? 'chip chip-ok' : 'chip'}>
                                {c.onDevice ? 'On the device' : 'App only'}
                            </span>
                            <span className="contact-actions">
                                {!c.onDevice && (
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        enabled={!busy && connected()}
                                        onPress={() => enroll(c)}
                                    >
                                        Add {c.name} to device
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    enabled={!enrolling}
                                    aria-label={`Remove ${c.name} from the app`}
                                    onPress={() => {
                                        book.remove(c.name);
                                        const msg = `Removed ${c.name} from the app contacts. ${c.onDevice ? 'It is still on the device.' : ''}`;
                                        log('app', msg);
                                        say(msg);
                                        bump();
                                        nameRef.current?.focus();
                                    }}
                                >
                                    Remove
                                </Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <form
                className="subform"
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    if (enrolling) {
                        alertUser('Wait for the device to finish adding the current contact.');
                        return;
                    }
                    const problem = book.add(name, address);
                    if (problem !== null) {
                        const field = problem.startsWith('Name') || problem.includes('named') ? 'name' : 'address';
                        setError({ text: problem, field });
                        alertUser(problem);
                        (field === 'name' ? nameRef : addressRef).current?.focus();
                        return;
                    }
                    const added = book.find(name.trim());
                    setError(null);
                    log('app', `Added ${added?.name ?? ''} to the app contacts.`);
                    setName('');
                    setAddress('');
                    bump();
                    if (added) {
                        void enroll(added); // the device asks, announces and confirms
                    }
                }}
            >
                <h3 className="subform-title">Add a contact</h3>
                <div className="grid-2">
                    <div>
                        <label htmlFor="contact-name">Name</label>
                        <input
                            ref={nameRef}
                            id="contact-name"
                            type="text"
                            autoComplete="off"
                            maxLength={12}
                            aria-describedby="contact-error"
                            aria-invalid={error?.field === 'name' ? true : undefined}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>
                    <div>
                        <label htmlFor="contact-address">Wallet address</label>
                        <input
                            ref={addressRef}
                            id="contact-address"
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            aria-describedby="contact-error"
                            aria-invalid={error?.field === 'address' ? true : undefined}
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                        />
                    </div>
                </div>
                <p id="contact-error" className="error">
                    {error?.text ?? ''}
                </p>
                <Button type="submit" variant="primary" enabled={!enrolling}>
                    Add contact
                </Button>
            </form>
        </Panel>
    );
}
