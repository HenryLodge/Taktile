// node --test tools/   (no network)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_PROMPT, TOOL_NAME, agentBody, main, plan, toolConfig } from './setup-agent.mjs';

test('client tool: one required string parameter, the agent waits for the answer', () => {
    const t = toolConfig().tool_config;
    assert.equal(t.type, 'client');
    assert.equal(t.name, TOOL_NAME);
    assert.equal(t.expects_response, true);
    assert.deepEqual(t.parameters.required, ['name']);
    assert.equal(t.parameters.properties.name.type, 'string');
});

test('agent: signed token required, only prompt and first message may be overridden, tool attached', () => {
    const b = agentBody({ toolId: 'tool_1', voiceId: 'voice_app' });
    assert.equal(b.platform_settings.auth.enable_auth, true);
    assert.deepEqual(b.platform_settings.overrides.conversation_config_override, {
        agent: { first_message: true, prompt: { prompt: true } },
    });
    assert.deepEqual(b.conversation_config.agent.prompt.tool_ids, ['tool_1']);
    assert.equal(b.conversation_config.tts.voice_id, 'voice_app');
    assert.equal(b.conversation_config.conversation.max_duration_seconds, 60);
    assert.equal(agentBody({ toolId: 't', voiceId: '' }).conversation_config.tts, undefined);
});

test('prompt: picks only from the list, can cancel, never talks about money', () => {
    assert.match(BASE_PROMPT, /exact name from the list/);
    assert.match(BASE_PROMPT, /not in the list/);
    assert.match(BASE_PROMPT, /cancel/i);
    assert.match(BASE_PROMPT, /Never mention money, amounts, tokens, addresses or transactions/);
});

test('plan: reuse the tool by name, update a known agent', () => {
    assert.deepEqual(plan({ existingToolId: undefined, agentId: '' }), { createTool: true, agentAction: 'create' });
    assert.deepEqual(plan({ existingToolId: 'tool_1', agentId: 'agent_1' }), {
        createTool: false,
        agentAction: 'update',
    });
});

test('dry run sends nothing; bad arguments are refused', async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        throw new Error('no network in tests');
    };
    const log = console.log;
    console.log = () => undefined;
    try {
        assert.equal(await main(['--dry-run'], { ELEVENLABS_API_KEY: 'sk_x' }), 0);
        assert.equal(await main(['--mainnet'], {}), 2);
        assert.equal(await main([], {}), 1); // no key
    } finally {
        console.log = log;
        globalThis.fetch = realFetch;
    }
    assert.equal(called, false);
});
