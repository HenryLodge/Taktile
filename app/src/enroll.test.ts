import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runContactAdd, type EnrollReport } from './enroll.ts';
import { DeviceClient } from './proto/client.ts';
import { EVENT, MSG, PROTO_ERROR, STATUS } from './proto/codes.ts';
import { MockTransport, reply, type MockStep } from './transport/mock.ts';

const R = 0x80;
const TEST = { name: 'Test', address: '4jT8Uy4HfCvE2C51yGYaWzvJmBTZcoprygkZhi78memK' };

function run(steps: MockStep[]) {
    const t = new MockTransport(steps);
    const client = new DeviceClient(t);
    const reports: EnrollReport[] = [];
    let refreshed = 0;
    const go = () =>
        runContactAdd(TEST, {
            client,
            report: (r) => void reports.push(r),
            refreshCount: async () => void refreshed++,
        });
    return { t, client, reports, go, refreshed: () => refreshed };
}

const answers = (status: number, events: number[] = [EVENT.ANNOUNCING]): MockStep => ({
    expect: { type: MSG.CONTACT_ADD },
    reply: (q) => [...events.map((e) => reply(MSG.EVENT, [e])(q)), reply(MSG.CONTACT_ADD | R, [status])(q)],
});

test('OK: events shown (not spoken), result spoken, marked on the device, count refreshed', async () => {
    const h = run([answers(STATUS.OK, [EVENT.ANNOUNCING, EVENT.AWAITING_PIN, EVENT.AWAITING_CONFIRM])]);
    const out = await h.go();
    assert.deepEqual(out, { stored: true, onDevice: true, status: STATUS.OK });
    assert.equal(h.refreshed(), 1);
    assert.equal(h.reports[0]?.kind, 'start');
    assert.match(h.reports[0]?.text ?? '', /8-word address phrase/);
    assert.deepEqual(
        h.reports.filter((r) => r.kind === 'device').map((r) => r.text),
        ['The device is speaking.', 'Enter your PIN on the device.', 'Press Confirm or Reject on the device.'],
    );
    assert.equal(h.reports.at(-1)?.kind, 'result');
    assert.equal(h.reports.at(-1)?.text, 'Test is now a contact on the device.');
    assert.equal(h.reports.filter((r) => r.kind === 'result').length, 1);
});

const CASES: [string, number, { onDevice: boolean; level: 'info' | 'alert'; text: RegExp }][] = [
    ['CONTACT_EXISTS', STATUS.CONTACT_EXISTS, { onDevice: true, level: 'info', text: /already on the device/ }],
    ['REJECTED_BY_USER', STATUS.REJECTED_BY_USER, { onDevice: false, level: 'alert', text: /rejected on the device/ }],
    ['CANCELLED', STATUS.CANCELLED, { onDevice: false, level: 'info', text: /cancelled/ }],
    ['CONTACTS_FULL', STATUS.CONTACTS_FULL, { onDevice: false, level: 'alert', text: /full \(16/ }],
    ['LOCKED_OUT', STATUS.LOCKED_OUT, { onDevice: false, level: 'alert', text: /wiped its wallet/ }],
    ['NO_WALLET', STATUS.NO_WALLET, { onDevice: false, level: 'alert', text: /no wallet/ }],
    ['DEVICE_ERROR', STATUS.DEVICE_ERROR, { onDevice: false, level: 'alert', text: /can't do this safely/ }],
];
for (const [name, status, want] of CASES) {
    test(`${name}`, async () => {
        const h = run([answers(status, [])]);
        const out = await h.go();
        assert.equal(out.stored, false);
        assert.equal(out.onDevice, want.onDevice);
        assert.equal(out.status, status);
        assert.equal(h.refreshed(), 0);
        const last = h.reports.at(-1);
        assert.equal(last?.kind, 'result');
        assert.equal(last?.level, want.level);
        assert.match(last?.text ?? '', want.text);
    });
}

test('ERROR{BAD_PAYLOAD}: the device refused the name', async () => {
    const h = run([
        { expect: { type: MSG.CONTACT_ADD }, reply: (q) => [reply(MSG.ERROR, [PROTO_ERROR.BAD_PAYLOAD])(q)] },
    ]);
    const out = await h.go();
    assert.equal(out.onDevice, false);
    assert.match(h.reports.at(-1)?.text ?? '', /refused the name/);
});

test('a flow already running: refused locally, nothing sent', async () => {
    const h = run([{ expect: { type: MSG.UNLOCK } }]);
    const pending = h.client.unlock().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const out = await h.go();
    assert.equal(out.status, null);
    assert.equal(h.t.written.length, 1); // only the UNLOCK
    assert.match(h.reports.at(-1)?.text ?? '', /Wait for the current request/);
    await h.client.close(); // clears the pending flow's timeout
    await pending;
});
