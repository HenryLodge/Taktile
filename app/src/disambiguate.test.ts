import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppContact } from './contacts.ts';
import {
    agentPrompt,
    chooseContact,
    matchAnswer,
    question,
    type AgentHandlers,
    type DisambiguateDeps,
    type StartAgent,
} from './disambiguate.ts';

const MILLER: AppContact = { name: 'Jack Miller', address: '11111111111111111111111111111114' };
const CHEN: AppContact = { name: 'Jack Chen', address: '11111111111111111111111111111115' };
const JACKS = [MILLER, CHEN];
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface FakeAgent {
    start: StartAgent;
    handlers: () => AgentHandlers;
    ended: () => boolean;
    started: () => { firstMessage: string; prompt: string } | null;
}

function fakeAgent(opts: { fail?: boolean } = {}): FakeAgent {
    let h: AgentHandlers | null = null;
    let ended = false;
    let started: { firstMessage: string; prompt: string } | null = null;
    return {
        start: async (_token, firstMessage, prompt, handlers) => {
            if (opts.fail) {
                throw new Error('microphone denied');
            }
            h = handlers;
            started = { firstMessage, prompt };
            return {
                end: async () => {
                    ended = true;
                },
            };
        },
        handlers: () => {
            assert.ok(h, 'agent not started');
            return h;
        },
        ended: () => ended,
        started: () => started,
    };
}

function deps(over: Partial<DisambiguateDeps> & { tokenStatus?: number } = {}) {
    const said: string[] = [];
    const reports: string[] = [];
    const logs: string[] = [];
    let stops = 0;
    let answer: string | null = null;
    const { tokenStatus, ...rest } = over;
    const d: DisambiguateDeps = {
        fetch: (async () =>
            tokenStatus && tokenStatus !== 200
                ? new Response(JSON.stringify({ error: 'no_agent' }), { status: tokenStatus })
                : new Response(JSON.stringify({ token: 'tok' }))) as typeof fetch,
        startAgent: null,
        useAgent: () => true,
        speaker: {
            stop: () => void stops++,
            speakAndWait: async (t) => void said.push(t),
        },
        listenOnce: async () => answer,
        report: (t) => void reports.push(t),
        log: (l) => void logs.push(l),
        sessionTimeoutMs: 200,
        ...rest,
    };
    return { d, said, reports, logs, stops: () => stops, setAnswer: (a: string | null) => (answer = a) };
}

test('question and prompt name only the candidates; the prompt never mentions an amount or address', () => {
    assert.equal(question(JACKS), 'Did you mean Jack Miller or Jack Chen?');
    assert.equal(
        question([...JACKS, { name: 'Jack Brown', address: MILLER.address }]),
        'Did you mean Jack Miller, Jack Chen, or Jack Brown?',
    );
    const p = agentPrompt(JACKS);
    assert.match(p, /- Jack Miller\n- Jack Chen/);
    assert.doesNotMatch(p, /USDC|SOL|1111/);
});

test('matchAnswer: full name, distinguishing word, cancel, nothing', () => {
    assert.equal(matchAnswer('Jack Chen.', JACKS), CHEN);
    assert.equal(matchAnswer('Chen', JACKS), CHEN);
    assert.equal(matchAnswer('the Miller one please', JACKS), MILLER);
    assert.equal(matchAnswer('Cancel.', JACKS), 'cancel');
    assert.equal(matchAnswer('neither', JACKS), 'cancel');
    assert.equal(matchAnswer('Jack', JACKS), null); // the shared word decides nothing
    assert.equal(matchAnswer('Bob', JACKS), null);
    assert.equal(matchAnswer('Miller and Chen', JACKS), null);
});

test('agent: picks Jack Chen; the app voice was stopped first; the session ends', async () => {
    const agent = fakeAgent();
    const h = deps({ startAgent: agent.start });
    const p = chooseContact(JACKS, h.d);
    await tick(10);
    assert.equal(h.stops(), 1);
    assert.equal(agent.started()?.firstMessage, 'Did you mean Jack Miller or Jack Chen?');
    const reply = agent.handlers().onChoose('jack chen');
    assert.match(reply, /OK, Jack Chen/);
    agent.handlers().onMode('listening');
    assert.equal(await p, CHEN);
    assert.equal(agent.ended(), true);
});

test('agent: a name outside the list is refused, then a valid choice works', async () => {
    const agent = fakeAgent();
    const h = deps({ startAgent: agent.start, sessionTimeoutMs: 5000 });
    const p = chooseContact(JACKS, h.d);
    await tick(10);
    assert.match(agent.handlers().onChoose('Bob'), /not in the list/);
    assert.match(agent.handlers().onChoose('Jack Miller'), /OK, Jack Miller/);
    assert.equal(await p, MILLER);
    assert.ok(h.logs.some((l) => l.includes('not in the list: refused')));
});

test('agent: no choice in time -> null, session ended', async () => {
    const agent = fakeAgent();
    const h = deps({ startAgent: agent.start, sessionTimeoutMs: 30 });
    assert.equal(await chooseContact(JACKS, h.d), null);
    assert.equal(agent.ended(), true);
    assert.ok(h.reports.includes('No answer. Not sending.'));
});

test('agent: the user says cancel -> null', async () => {
    const agent = fakeAgent();
    const h = deps({ startAgent: agent.start, sessionTimeoutMs: 5000 });
    const p = chooseContact(JACKS, h.d);
    await tick(10);
    agent.handlers().onMessage('Cancel.', 'user');
    assert.equal(await p, null);
    assert.equal(agent.ended(), true);
});

test('agent: Esc (abort) -> null', async () => {
    const agent = fakeAgent();
    const ac = new AbortController();
    const h = deps({ startAgent: agent.start, signal: ac.signal, sessionTimeoutMs: 5000 });
    const p = chooseContact(JACKS, h.d);
    await tick(10);
    ac.abort();
    assert.equal(await p, null);
    assert.equal(agent.ended(), true);
});

test('agent disconnects after a choice: the choice stands', async () => {
    const agent = fakeAgent();
    const h = deps({ startAgent: agent.start, sessionTimeoutMs: 5000 });
    const p = chooseContact(JACKS, h.d);
    await tick(10);
    agent.handlers().onChoose('Jack Chen');
    agent.handlers().onEnd();
    assert.equal(await p, CHEN);
});

const FALLBACKS: [string, Partial<DisambiguateDeps> & { tokenStatus?: number }, boolean][] = [
    ['token 503 (no agent configured)', { tokenStatus: 503 }, false],
    ['the assistant is switched off', { useAgent: () => false }, false],
    ['the session fails to start', {}, true],
];
for (const [why, over, failStart] of FALLBACKS) {
    test(`fallback when ${why}: the app voice asks, "Chen" picks Jack Chen`, async () => {
        const agent = fakeAgent({ fail: failStart });
        const h = deps({ startAgent: agent.start, ...over });
        h.setAnswer('Chen');
        assert.equal(await chooseContact(JACKS, h.d), CHEN);
        assert.deepEqual(h.said, ['Did you mean Jack Miller or Jack Chen? Hold Space and say the name.']);
    });
}

test('fallback: cancel, an unknown name, or no answer -> null after one round', async () => {
    for (const a of ['cancel', 'Bob', null]) {
        const h = deps({ useAgent: () => false });
        h.setAnswer(a);
        assert.equal(await chooseContact(JACKS, h.d), null, String(a));
        assert.equal(h.said.length, 1);
    }
});

test('fewer than two candidates: no question', async () => {
    const h = deps();
    assert.equal(await chooseContact([CHEN], h.d), CHEN);
    assert.equal(h.said.length, 0);
});
