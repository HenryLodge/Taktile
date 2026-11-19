// The app's own contact list: name -> address, for turning "Henry" into an address. UNTRUSTED: it
// lives on the laptop, and the device checks every destination against its own contact book (I3).
// The app asks the device to add each new contact (CONTACT_ADD, src/enroll.ts); `onDevice` only
// records that the device answered OK or "already a contact". It is a display hint, never a check.

import { PublicKey } from '@solana/web3.js';

export interface AppContact {
    name: string;
    address: string; // base58
    /** The device confirmed it holds this contact (OK or CONTACT_EXISTS). Display only. */
    onDevice?: boolean;
}

export const STORAGE_KEY = 'tk.contacts.v1';

/** The device's contact-name rules (core/src/tk_contacts.c). */
export function validContactName(name: string): boolean {
    return /^[A-Za-z0-9 '-]{1,12}$/.test(name) && !name.startsWith(' ') && !name.endsWith(' ') && !name.includes('  ');
}

export function validAddress(address: string): boolean {
    try {
        return new PublicKey(address).toBase58() === address;
    } catch {
        return false;
    }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class ContactBook {
    private contacts: AppContact[] = [];
    private readonly storage: StorageLike | null;

    constructor(storage: StorageLike | null) {
        this.storage = storage;
        try {
            const raw = storage?.getItem(STORAGE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed)) {
                this.contacts = parsed
                    .filter(
                        (c): c is AppContact =>
                            typeof c?.name === 'string' &&
                            typeof c?.address === 'string' &&
                            validContactName(c.name) &&
                            validAddress(c.address),
                    )
                    .map((c) => ({ name: c.name, address: c.address, onDevice: c.onDevice === true }));
            }
        } catch {
            this.contacts = []; // unreadable storage: start empty, keep working in memory
        }
    }

    list(): readonly AppContact[] {
        return this.contacts;
    }

    find(name: string): AppContact | undefined {
        const n = name.toLowerCase();
        return this.contacts.find((c) => c.name.toLowerCase() === n);
    }

    /** Returns an error message, or null when added. */
    add(name: string, address: string): string | null {
        const n = name.trim();
        const a = address.trim();
        if (!validContactName(n)) {
            return 'Name: 1 to 12 letters, digits, spaces, hyphens or apostrophes, with no space at either end and no double spaces.';
        }
        if (this.find(n)) {
            return `There is already a contact named ${n}.`;
        }
        if (!validAddress(a)) {
            return 'Address: paste a Solana wallet address (base58, 32 to 44 characters).';
        }
        if (this.contacts.some((c) => c.address === a)) {
            return 'That address is already in the list.';
        }
        this.contacts = [...this.contacts, { name: n, address: a, onDevice: false }];
        this.save();
        return null;
    }

    /** Records the device's answer for this contact (OK or CONTACT_EXISTS). */
    markOnDevice(name: string, onDevice = true): void {
        const n = name.toLowerCase();
        this.contacts = this.contacts.map((c) => (c.name.toLowerCase() === n ? { ...c, onDevice } : c));
        this.save();
    }

    remove(name: string): void {
        const n = name.toLowerCase();
        this.contacts = this.contacts.filter((c) => c.name.toLowerCase() !== n);
        this.save();
    }

    private save(): void {
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.contacts));
        } catch {
            // storage full or blocked: the list still works until the page reloads
        }
    }
}
