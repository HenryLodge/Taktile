// Adding a contact to the device (CONTACT_ADD). The app only asks; the device does the trusted part:
// it spells the name and reads the 8-word address phrase computed from the address it received, then
// requires PIN (if locked) and CONFIRM (docs/AUDIO.md "Adding a contact"). The user checks the 8 words
// with the contact over the phone; the contact reads them from their own copy ("My address phrase").

import type { AppContact } from './contacts.ts';
import { BadNameError, DeviceProtocolError, type DeviceClient } from './proto/client.ts';
import { PROTO_ERROR, STATUS, eventText, statusText } from './proto/codes.ts';
import { PublicKey } from '@solana/web3.js';

export interface EnrollReport {
    text: string;
    /** 'start' and 'device' lines go to the screen and live region only (the device is speaking);
     *  'result' lines are also spoken by the app voice. */
    kind: 'start' | 'device' | 'result';
    level: 'info' | 'alert';
}

export interface EnrollDeps {
    client: DeviceClient;
    report: (r: EnrollReport) => void;
    /** Refreshes the device's contact count after a successful add. */
    refreshCount?: () => Promise<void>;
}

export type EnrollOutcome = { stored: boolean; onDevice: boolean; status: number | null };

export async function runContactAdd(contact: AppContact, d: EnrollDeps): Promise<EnrollOutcome> {
    const result = (text: string, level: 'info' | 'alert', out: EnrollOutcome): EnrollOutcome => {
        d.report({ text, kind: 'result', level });
        return out;
    };
    if (d.client.flowRunning) {
        return result('Wait for the current request on the device to finish.', 'alert', {
            stored: false,
            onDevice: false,
            status: null,
        });
    }
    d.report({
        kind: 'start',
        level: 'info',
        text:
            `Adding ${contact.name} to the device. Listen to the device: it spells the name and reads an ` +
            `8-word address phrase. Check the words with ${contact.name} over the phone, then confirm on the device.`,
    });
    let status: number;
    try {
        status = await d.client.contactAdd(contact.name, new PublicKey(contact.address).toBytes(), (e) =>
            d.report({ kind: 'device', level: 'info', text: eventText(e) }),
        );
    } catch (e) {
        if (e instanceof BadNameError || (e instanceof DeviceProtocolError && e.code === PROTO_ERROR.BAD_PAYLOAD)) {
            return result(
                'The device refused the name. Use letters, digits, spaces, hyphens or apostrophes.',
                'alert',
                { stored: false, onDevice: false, status: null },
            );
        }
        const m = e instanceof Error ? e.message : String(e);
        return result(`Adding ${contact.name} failed: ${m}`, 'alert', { stored: false, onDevice: false, status: null });
    }
    switch (status) {
        case STATUS.OK:
            await d.refreshCount?.().catch(() => undefined);
            return result(`${contact.name} is now a contact on the device.`, 'info', {
                stored: true,
                onDevice: true,
                status,
            });
        case STATUS.CONTACT_EXISTS:
            return result(`${contact.name} or that address is already on the device.`, 'info', {
                stored: false,
                onDevice: true,
                status,
            });
        case STATUS.REJECTED_BY_USER:
            return result('Not added: rejected on the device.', 'alert', { stored: false, onDevice: false, status });
        case STATUS.CANCELLED:
            return result('Not added: cancelled.', 'info', { stored: false, onDevice: false, status });
        case STATUS.CONTACTS_FULL:
            return result('The device contact book is full (16 contacts).', 'alert', {
                stored: false,
                onDevice: false,
                status,
            });
        default:
            return result(`Not added. ${statusText(status)}`, 'alert', { stored: false, onDevice: false, status });
    }
}
