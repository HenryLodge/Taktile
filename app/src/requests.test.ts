import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppContact } from './contacts.ts';
import {
    PaidWatcher,
    RequestsError,
    createRequest,
    describeFor,
    describeRequests,
    listRequests,
    type FetchFn,
    type PayRequest,
} from './requests.ts';

const MAX: AppContact = { name: 'Max', address: '11111111111111111111111111111112' };
const ANN: AppContact = { name: 'Ann', address: '11111111111111111111111111111113' };
const ME = '3jnhQ6a1kZ6uLNQmXcqcA8qwoV9w6PVUeG27ncYyTCq7';

const req = (over: Partial<PayRequest> = {}): PayRequest => ({
    id: 'a'.repeat(24),
    recipient: ME,
    token: 'USDC',
    amount: '5000000',
    payer: MAX.address,
    payerName: 'Max',
    requesterName: 'Henry',
    reference: '11111111111111111111111111111114',
    createdAt: 1,
    expiresAt: 2,
    status: 'pending',
    signature: null,
    ...over,
});

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('createRequest posts base units as a string and the contact as payer', async () => {
    let sent: unknown = null;
    const f: FetchFn = async (url, init) => {
        assert.equal(url, '/api/requests');
        sent = JSON.parse(String(init?.body));
        return json(201, req());
    };
    const r = await createRequest(f, { recipient: ME, token: 'USDC', amount: 5_000_000n, payer: MAX });
    assert.deepEqual(sent, { recipient: ME, token: 'USDC', amount: '5000000', payer: MAX.address, payerName: 'Max' });
    assert.equal(r.id, 'a'.repeat(24));
});

test('server errors become one readable sentence; malformed replies are refused', async () => {
    const down: FetchFn = async () => {
        throw new TypeError('Failed to fetch');
    };
    await assert.rejects(listRequests(down, { recipient: ME }), /isn't running/);
    const bad: FetchFn = async () => json(400, { error: 'bad_request', message: 'token must be SOL or USDC' });
    await assert.rejects(listRequests(bad, { recipient: ME }), /token must be SOL or USDC/);
    const old: FetchFn = async () => new Response('nope', { status: 404 });
    await assert.rejects(listRequests(old, { recipient: ME }), /Restart it/);
    const junk: FetchFn = async () => json(200, { requests: [{ id: 1 }] });
    await assert.rejects(listRequests(junk, { recipient: ME }), RequestsError);
    const junk2: FetchFn = async () => json(201, req({ amount: '1.5' }));
    await assert.rejects(createRequest(junk2, { recipient: ME, token: 'USDC', amount: 1n, payer: MAX }), RequestsError);
});

test('listRequests asks by recipient or payer', async () => {
    const urls: string[] = [];
    const f: FetchFn = async (url) => (urls.push(url), json(200, { requests: [req()] }));
    await listRequests(f, { recipient: ME });
    await listRequests(f, { payer: MAX.address });
    assert.deepEqual(urls, [`/api/requests?recipient=${ME}`, `/api/requests?payer=${MAX.address}`]);
});

test('describeRequests: paid first, then pending; expired left out; names from contacts', () => {
    assert.deepEqual(describeRequests([], [MAX]), ['You have no open payment requests.']);
    assert.deepEqual(
        describeRequests(
            [
                req({ status: 'pending' }),
                req({ status: 'paid', payer: ANN.address, payerName: 'ann', token: 'SOL', amount: '10000000' }),
                req({ status: 'expired' }),
            ],
            [MAX, ANN],
        ),
        ['Ann paid 0.01 SOL.', 'Max has not paid 5 USDC yet.'],
    );
    const many = Array.from({ length: 7 }, () => req());
    assert.equal(describeRequests(many, [MAX]).length, 5);
    assert.equal(describeRequests(many, [MAX])[4], 'And 3 more.');
});

test('describeFor: the newest request to that contact', () => {
    assert.equal(describeFor([], MAX), 'You have no payment requests to Max.');
    assert.equal(describeFor([req({ status: 'paid' }), req()], MAX), 'Yes. Max paid your request for 5 USDC.');
    assert.equal(describeFor([req()], MAX), 'Not yet. Max has not paid your request for 5 USDC.');
    assert.equal(describeFor([req({ status: 'expired' })], MAX), 'No. Your request to Max for 5 USDC expired.');
    assert.equal(describeFor([req()], ANN), 'You have no payment requests to Ann.');
});

test('PaidWatcher: announces each request once when it turns paid, then stops', async () => {
    let list = [req({ id: '1'.repeat(24) }), req({ id: '2'.repeat(24) })];
    const paid: string[] = [];
    const w = new PaidWatcher(
        async () => list,
        (r) => paid.push(r.id),
        60_000,
    );
    w.track(list);
    assert.equal(w.watching, 2);
    await w.tick();
    assert.deepEqual(paid, []);
    list = [req({ id: '1'.repeat(24), status: 'paid' }), req({ id: '2'.repeat(24), status: 'expired' })];
    await w.tick();
    await w.tick();
    assert.deepEqual(paid, ['1'.repeat(24)]);
    assert.equal(w.watching, 0);
    w.stop();
});

test('PaidWatcher: a failing poll keeps watching', async () => {
    const w = new PaidWatcher(
        async () => {
            throw new Error('down');
        },
        () => assert.fail('nothing is paid'),
        60_000,
    );
    w.track([req()]);
    await w.tick();
    assert.equal(w.watching, 1);
    w.stop();
});

test('a request may carry its Blink link; anything but a solana-action: URL is refused', async () => {
    const ok: FetchFn = async () =>
        json(201, req({ blink: 'solana-action:http://localhost:8787/api/actions/request/x' }));
    const r = await createRequest(ok, { recipient: ME, token: 'USDC', amount: 1n, payer: MAX });
    assert.equal(r.blink, 'solana-action:http://localhost:8787/api/actions/request/x');
    const bad: FetchFn = async () => json(201, req({ blink: 'javascript:alert(1)' }));
    await assert.rejects(createRequest(bad, { recipient: ME, token: 'USDC', amount: 1n, payer: MAX }), RequestsError);
});
