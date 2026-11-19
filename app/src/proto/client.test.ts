import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MockTransport, reply, type MockStep } from '../transport/mock.ts';
import {
    DeviceClient,
    DeviceProtocolError,
    DisconnectedError,
    FlowBusyError,
    ProtoVersionError,
    RequestTimeoutError,
    type ClientOptions,
} from './client.ts';
import { EVENT, MSG, PROTO_ERROR, STATUS } from './codes.ts';
import { encodeFrame } from './frame.ts';

const R = 0x80;
const PUBKEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function setup(steps: MockStep[], opts: ClientOptions = {}, chunked = false) {
    const t = new MockTransport(steps, { chunked });
    const c = new DeviceClient(t, opts);
    return { t, c };
}

const helloStep = (state = 1, proto = 1): MockStep => ({
    expect: { type: MSG.HELLO },
    reply: (q) => [reply(MSG.HELLO | R, [0x01, 0x00, proto, state])(q)],
});

test('HELLO parses fw, proto, state', async () => {
    const { t, c } = setup([helloStep(2)]);
    assert.deepEqual(await c.hello(), { fw: 1, proto: 1, state: 2 });
    assert.deepEqual(t.errors, []);
    assert.equal(t.written[0]?.seq, 1);
});

test('HELLO with another protocol version is refused', async () => {
    const { c } = setup([helloStep(1, 2)]);
    await assert.rejects(c.hello(), ProtoVersionError);
});

test('GET_PUBKEY ok and no wallet', async () => {
    const { c } = setup([
        { expect: { type: MSG.GET_PUBKEY }, reply: (q) => [reply(MSG.GET_PUBKEY | R, [STATUS.OK, ...PUBKEY])(q)] },
        { expect: { type: MSG.GET_PUBKEY }, reply: (q) => [reply(MSG.GET_PUBKEY | R, [STATUS.NO_WALLET])(q)] },
    ]);
    assert.deepEqual(await c.getPubkey(), { status: STATUS.OK, pubkey: PUBKEY });
    assert.deepEqual(await c.getPubkey(), { status: STATUS.NO_WALLET, pubkey: null });
});

test('a short reply is rejected, not read past its end', async () => {
    const { c } = setup([
        { expect: { type: MSG.GET_PUBKEY }, reply: (q) => [reply(MSG.GET_PUBKEY | R, [STATUS.OK, 1, 2])(q)] },
    ]);
    await assert.rejects(c.getPubkey(), /33/);
});

test('UNLOCK delivers events, then the status (chunked replies)', async () => {
    const { t, c } = setup(
        [
            {
                expect: { type: MSG.UNLOCK },
                reply: (q) => [
                    reply(MSG.EVENT, [EVENT.AWAITING_PIN])(q),
                    reply(MSG.EVENT, [EVENT.AWAITING_PIN])(q),
                    reply(MSG.UNLOCK | R, [STATUS.OK])(q),
                ],
            },
        ],
        {},
        true,
    );
    const events: number[] = [];
    assert.equal(await c.unlock((e) => events.push(e)), STATUS.OK);
    assert.deepEqual(events, [EVENT.AWAITING_PIN, EVENT.AWAITING_PIN]);
    assert.equal(c.flowRunning, false);
    assert.deepEqual(t.errors, []);
});

test('HELLO is answered while a flow runs; a second flow is refused locally', async () => {
    const t = new MockTransport([
        { expect: { type: MSG.UNLOCK } }, // no reply yet
        helloStep(1),
    ]);
    const c = new DeviceClient(t);
    const unlock = c.unlock();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(c.flowRunning, true);
    assert.equal((await c.hello()).state, 1);
    await assert.rejects(c.request(MSG.SIGN_REQUEST, Uint8Array.of(1)), FlowBusyError);
    assert.equal(t.written.length, 2); // the refused flow sent nothing
    // finish the unlock
    t.inject(encodeFrame(MSG.UNLOCK | R, t.written[0]?.seq ?? 0, Uint8Array.of(STATUS.OK)));
    assert.equal(await unlock, STATUS.OK);
});

test('BUSY status passes through', async () => {
    const { c } = setup([{ expect: { type: MSG.UNLOCK }, reply: (q) => [reply(MSG.UNLOCK | R, [STATUS.BUSY])(q)] }]);
    assert.equal(await c.unlock(), STATUS.BUSY);
});

test('CANCEL gets OK, then the flow gets CANCELLED', async () => {
    const t = new MockTransport([
        { expect: { type: MSG.UNLOCK } },
        { expect: { type: MSG.CANCEL }, reply: (q) => [reply(MSG.CANCEL | R, [STATUS.OK])(q)] },
    ]);
    const c = new DeviceClient(t);
    const unlock = c.unlock();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(await c.cancel(), STATUS.OK);
    t.inject(encodeFrame(MSG.UNLOCK | R, t.written[0]?.seq ?? 0, Uint8Array.of(STATUS.CANCELLED)));
    assert.equal(await unlock, STATUS.CANCELLED);
});

test('ERROR frame rejects the request with its code', async () => {
    const { c } = setup([
        { expect: { type: MSG.UNLOCK }, reply: (q) => [reply(MSG.ERROR, [PROTO_ERROR.UNKNOWN_TYPE])(q)] },
    ]);
    await assert.rejects(
        c.unlock(),
        (e: unknown) => e instanceof DeviceProtocolError && e.code === PROTO_ERROR.UNKNOWN_TYPE,
    );
    assert.equal(c.flowRunning, false);
});

test('replies with the wrong seq or type are ignored', async () => {
    const { c } = setup([
        {
            expect: { type: MSG.HELLO },
            reply: (q) => [
                encodeFrame(MSG.HELLO | R, (q.seq + 1) & 0xff, Uint8Array.from([1, 0, 1, 0])),
                reply(MSG.GET_PUBKEY | R, [STATUS.NO_WALLET])(q),
                reply(MSG.HELLO | R, [1, 0, 1, 2])(q),
            ],
        },
    ]);
    assert.equal((await c.hello()).state, 2);
});

test('garbage and a stuck half frame do not block later replies', async () => {
    const t = new MockTransport([helloStep(1)]);
    const c = new DeviceClient(t, { idleResetMs: 20 });
    t.inject(new Uint8Array([0xe5, 0x01, 0x81, 0x01, 0x00, 0x08])); // claims 2048 bytes, never sent
    await new Promise((r) => setTimeout(r, 40)); // idle reset drops it
    assert.equal((await c.hello()).state, 1);
});

test('a flow timeout sends CANCEL', async () => {
    const t = new MockTransport([
        { expect: { type: MSG.UNLOCK } },
        { expect: { type: MSG.CANCEL }, reply: (q) => [reply(MSG.CANCEL | R, [STATUS.OK])(q)] },
    ]);
    const c = new DeviceClient(t, { flowTimeoutMs: 30 });
    await assert.rejects(c.unlock(), RequestTimeoutError);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.written[1]?.type, MSG.CANCEL);
    assert.equal(c.flowRunning, false);
});

test('a quick request times out without CANCEL', async () => {
    const t = new MockTransport([{ expect: { type: MSG.HELLO } }]);
    const c = new DeviceClient(t, { quickTimeoutMs: 20 });
    await assert.rejects(c.hello(), RequestTimeoutError);
    assert.equal(t.written.length, 1);
});

test('the link closing rejects everything pending and later requests', async () => {
    const t = new MockTransport([{ expect: { type: MSG.UNLOCK } }, { expect: { type: MSG.HELLO } }]);
    const c = new DeviceClient(t);
    let closedWith = '';
    c.onClose((r) => (closedWith = r));
    const a = c.unlock();
    const b = c.hello();
    await new Promise((r) => setTimeout(r, 0));
    t.remoteClose('unplugged');
    await assert.rejects(a, DisconnectedError);
    await assert.rejects(b, DisconnectedError);
    await assert.rejects(c.hello(), DisconnectedError);
    assert.equal(closedWith, 'unplugged');
});

test('seq wraps 255 -> 1 and is never 0', async () => {
    const steps: MockStep[] = Array.from({ length: 260 }, () => helloStep(1));
    const { t, c } = setup(steps);
    for (let i = 0; i < 260; i++) {
        await c.hello();
    }
    const seqs = t.written.map((f) => f.seq);
    assert.equal(seqs[254], 255);
    assert.equal(seqs[255], 1);
    assert.ok(!seqs.includes(0));
});

test('CONTACT_ADD payload: name_len | name | wallet', async () => {
    const wallet = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
    for (const name of ['Henry', "O'Brien", 'Mary Jo', 'Jean-Luc', 'A', 'abcdefghijkl']) {
        const want = Uint8Array.from([name.length, ...Buffer.from(name, 'ascii'), ...wallet]);
        const { t, c } = setup([
            {
                expect: { type: MSG.CONTACT_ADD, payload: want },
                reply: (q) => [reply(MSG.EVENT, [EVENT.ANNOUNCING])(q), reply(MSG.CONTACT_ADD | R, [STATUS.OK])(q)],
            },
        ]);
        assert.equal(await c.contactAdd(name, wallet), STATUS.OK, name);
        assert.deepEqual(t.errors, []);
        assert.equal(t.written[0]?.payload.length, 1 + name.length + 32);
    }
});

test('CONTACT_ADD refuses bad names and wallets locally, sending nothing', async () => {
    const { t, c } = setup([]);
    for (const bad of ['', ' Henry', 'Henry ', 'Mary  Jo', 'abcdefghijklm', 'Al!ce', 'Zoë']) {
        await assert.rejects(c.contactAdd(bad, new Uint8Array(32)), /contact name/, bad);
    }
    await assert.rejects(c.contactAdd('Henry', new Uint8Array(31)), /32 bytes/);
    assert.equal(t.written.length, 0);
});

test('CONTACT_ADD reply length is checked; BAD_PAYLOAD surfaces', async () => {
    const { c } = setup([
        { expect: { type: MSG.CONTACT_ADD }, reply: (q) => [reply(MSG.CONTACT_ADD | R, [STATUS.OK, 0])(q)] },
        { expect: { type: MSG.CONTACT_ADD }, reply: (q) => [reply(MSG.ERROR, [PROTO_ERROR.BAD_PAYLOAD])(q)] },
    ]);
    await assert.rejects(c.contactAdd('Henry', new Uint8Array(32)), /not 1/);
    await assert.rejects(
        c.contactAdd('Henry', new Uint8Array(32)),
        (e: unknown) => e instanceof DeviceProtocolError && e.code === PROTO_ERROR.BAD_PAYLOAD,
    );
});

test('SPEAK_ADDRESS: empty request, events, then a 1-byte status', async () => {
    const events: number[] = [];
    const { t, c } = setup([
        {
            expect: { type: MSG.SPEAK_ADDRESS },
            reply: (q) => [
                reply(MSG.EVENT, [EVENT.AWAITING_PIN])(q),
                reply(MSG.EVENT, [EVENT.ANNOUNCING])(q),
                reply(MSG.SPEAK_ADDRESS | R, [STATUS.OK])(q),
            ],
        },
    ]);
    assert.equal(await c.speakAddress((e) => events.push(e)), STATUS.OK);
    assert.deepEqual(events, [EVENT.AWAITING_PIN, EVENT.ANNOUNCING]);
    assert.equal(t.written[0]?.payload.length, 0);
});

test('SPEAK_CONTACTS: exactly status and count; any other length is refused', async () => {
    const { c } = setup([
        { expect: { type: MSG.SPEAK_CONTACTS }, reply: (q) => [reply(MSG.SPEAK_CONTACTS | R, [STATUS.OK, 3])(q)] },
        { expect: { type: MSG.SPEAK_CONTACTS }, reply: (q) => [reply(MSG.SPEAK_CONTACTS | R, [STATUS.OK])(q)] },
        {
            expect: { type: MSG.SPEAK_CONTACTS },
            reply: (q) => [reply(MSG.SPEAK_CONTACTS | R, [STATUS.OK, 1, 0x41, 0x6c])(q)],
        },
    ]);
    assert.deepEqual(await c.speakContacts(), { status: STATUS.OK, count: 3 });
    await assert.rejects(c.speakContacts(), /2/);
    await assert.rejects(c.speakContacts(), /2/);
});

test('LOCK: a flow with its own short timeout; status passes through', async () => {
    const { c } = setup([
        { expect: { type: MSG.LOCK }, reply: (q) => [reply(MSG.LOCK | R, [STATUS.OK])(q)] },
        { expect: { type: MSG.LOCK }, reply: (q) => [reply(MSG.LOCK | R, [STATUS.DEVICE_ERROR])(q)] },
    ]);
    assert.equal(await c.lock(), STATUS.OK);
    assert.equal(await c.lock(), STATUS.DEVICE_ERROR);
});

test('the voice-command flows are refused locally while another flow runs', async () => {
    const t = new MockTransport([{ expect: { type: MSG.SIGN_REQUEST } }]);
    const c = new DeviceClient(t);
    void c.signRequest(Uint8Array.of(1)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    await assert.rejects(c.speakAddress(), FlowBusyError);
    await assert.rejects(c.speakContacts(), FlowBusyError);
    await assert.rejects(c.lock(), FlowBusyError);
    assert.equal(t.written.length, 1);
    await c.close();
});
