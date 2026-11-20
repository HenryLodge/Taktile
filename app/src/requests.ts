// Payment requests (docs/EXTRATASKS.md Part 2 R), the requester's side: "request 5 USDC from Max"
// creates one in server/ (recipient = the device wallet, payer = Max's app-contact address); Max's
// Taktile Pay page picks it up; server/ asks devnet whether it was paid.
//
// Laptop-sourced information (SECURITY_MODEL "Command sources"): the device takes no part, because
// receiving money needs no signature. Nothing here is ever an input to signing.

import { DECIMALS, formatAmount, type Token } from './amount.ts';
import type { AppContact } from './contacts.ts';

export type RequestStatus = 'pending' | 'paid' | 'expired';

export interface PayRequest {
    id: string;
    recipient: string;
    token: Token;
    /** Base units, as a decimal string. */
    amount: string;
    payer: string;
    payerName: string;
    requesterName: string;
    reference: string;
    createdAt: number;
    expiresAt: number;
    status: RequestStatus;
    signature: string | null;
    explorer?: string;
    /** solana-action:<Action URL>, the request's Blink (B3). */
    blink?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class RequestsError extends Error {}

function isRequest(x: unknown): x is PayRequest {
    if (typeof x !== 'object' || x === null) {
        return false;
    }
    const r = x as Record<string, unknown>;
    return (
        typeof r.id === 'string' &&
        typeof r.recipient === 'string' &&
        (r.token === 'SOL' || r.token === 'USDC') &&
        typeof r.amount === 'string' &&
        /^\d+$/.test(r.amount) &&
        typeof r.payer === 'string' &&
        typeof r.payerName === 'string' &&
        typeof r.requesterName === 'string' &&
        typeof r.reference === 'string' &&
        typeof r.createdAt === 'number' &&
        typeof r.expiresAt === 'number' &&
        (r.status === 'pending' || r.status === 'paid' || r.status === 'expired') &&
        (r.signature === null || typeof r.signature === 'string') &&
        (r.blink === undefined || (typeof r.blink === 'string' && r.blink.startsWith('solana-action:')))
    );
}

async function call(fetchFn: FetchFn, path: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
        res = await fetchFn(path, init);
    } catch {
        throw new RequestsError("The Taktile server isn't running. Start it with npm run dev in the server folder.");
    }
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        // not JSON
    }
    if (!res.ok) {
        const m = (body as { message?: unknown } | null)?.message;
        throw new RequestsError(
            res.status === 404 && typeof m !== 'string'
                ? "The Taktile server doesn't know payment requests. Restart it from the latest code."
                : `Payment request failed: ${typeof m === 'string' ? m : `HTTP ${res.status}`}.`,
        );
    }
    return body;
}

export async function createRequest(
    fetchFn: FetchFn,
    r: { recipient: string; token: Token; amount: bigint; payer: AppContact },
): Promise<PayRequest> {
    const body = await call(fetchFn, '/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            recipient: r.recipient,
            token: r.token,
            amount: r.amount.toString(),
            payer: r.payer.address,
            payerName: r.payer.name.slice(0, 32),
        }),
    });
    if (!isRequest(body)) {
        throw new RequestsError('The Taktile server sent a malformed payment request.');
    }
    return body;
}

export async function listRequests(
    fetchFn: FetchFn,
    by: { recipient: string } | { payer: string },
): Promise<PayRequest[]> {
    const q = 'recipient' in by ? `recipient=${by.recipient}` : `payer=${by.payer}`;
    const body = await call(fetchFn, `/api/requests?${q}`);
    const list = (body as { requests?: unknown } | null)?.requests;
    if (!Array.isArray(list) || !list.every(isRequest)) {
        throw new RequestsError('The Taktile server sent a malformed list of payment requests.');
    }
    return list;
}

export const amountText = (r: PayRequest): string => `${formatAmount(BigInt(r.amount), DECIMALS[r.token])} ${r.token}`;

const nameOf = (r: PayRequest, contacts: readonly AppContact[]): string =>
    contacts.find((c) => c.address === r.payer)?.name ?? (r.payerName || 'an unknown wallet');

/** "do I have any requests": paid ones first, then pending, at most 5 lines. */
export function describeRequests(rs: readonly PayRequest[], contacts: readonly AppContact[]): string[] {
    const live = rs.filter((r) => r.status !== 'expired');
    if (live.length === 0) {
        return ['You have no open payment requests.'];
    }
    const paid = live.filter((r) => r.status === 'paid');
    const pending = live.filter((r) => r.status === 'pending');
    const lines = [
        ...paid.map((r) => `${nameOf(r, contacts)} paid ${amountText(r)}.`),
        ...pending.map((r) => `${nameOf(r, contacts)} has not paid ${amountText(r)} yet.`),
    ];
    return lines.length > 5 ? [...lines.slice(0, 4), `And ${lines.length - 4} more.`] : lines;
}

/** "did Max pay me": the newest request to that contact. */
export function describeFor(rs: readonly PayRequest[], contact: AppContact): string {
    const r = rs.find((x) => x.payer === contact.address);
    if (r === undefined) {
        return `You have no payment requests to ${contact.name}.`;
    }
    if (r.status === 'paid') {
        return `Yes. ${contact.name} paid your request for ${amountText(r)}.`;
    }
    if (r.status === 'expired') {
        return `No. Your request to ${contact.name} for ${amountText(r)} expired.`;
    }
    return `Not yet. ${contact.name} has not paid your request for ${amountText(r)}.`;
}

/**
 * Watches pending requests: `poll` returns the current list, and `onPaid` fires once per request
 * that turns paid. Stops polling by itself when nothing is pending.
 */
export class PaidWatcher {
    private readonly pending = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly poll: () => Promise<PayRequest[]>;
    private readonly onPaid: (r: PayRequest) => void;
    private readonly everyMs: number;

    constructor(poll: () => Promise<PayRequest[]>, onPaid: (r: PayRequest) => void, everyMs = 5000) {
        this.poll = poll;
        this.onPaid = onPaid;
        this.everyMs = everyMs;
    }

    /** Remember these; schedules polling while any is pending. */
    track(rs: readonly PayRequest[]): void {
        for (const r of rs) {
            if (r.status === 'pending') {
                this.pending.add(r.id);
            }
        }
        this.schedule();
    }

    async tick(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer); // called early (a test, or a future "check now"): one poll at a time
            this.timer = null;
        }
        let rs: PayRequest[];
        try {
            rs = await this.poll();
        } catch {
            this.schedule(); // server briefly gone: keep trying
            return;
        }
        for (const r of rs) {
            if (!this.pending.has(r.id)) {
                continue;
            }
            if (r.status === 'paid') {
                this.pending.delete(r.id);
                this.onPaid(r);
            } else if (r.status === 'expired') {
                this.pending.delete(r.id);
            }
        }
        this.schedule();
    }

    stop(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pending.clear();
    }

    get watching(): number {
        return this.pending.size;
    }

    private schedule(): void {
        if (this.timer === null && this.pending.size > 0) {
            this.timer = setTimeout(() => void this.tick(), this.everyMs);
        }
    }
}
