#!/usr/bin/env node
// Create (or update) the ElevenLabs agent that asks "Jack Miller or Jack Chen?" when a spoken name
// matches more than one contact. Safe to run again: it reuses the client tool by name and, when
// ELEVENLABS_AGENT_ID is set, updates that agent instead of creating another.
//
//   node --env-file=server/.env tools/setup-agent.mjs [--dry-run]
//
// The agent's ONLY job is to call the client tool `choose_contact` with one of the names the app lists
// in the session's prompt override. It never sees an amount, token, address or transaction; the app
// checks the chosen name against its own candidate list, and the device announces the real recipient
// it has stored (docs/SECURITY_MODEL.md I3). The key needs the Agents (Conversational AI) permission.

import { pathToFileURL } from 'node:url';

export const API = 'https://api.elevenlabs.io';
export const TOOL_NAME = 'choose_contact';
export const AGENT_NAME = 'Taktile disambiguation';

/** The fixed system prompt; the app appends the candidate list per session (prompt override). */
export const BASE_PROMPT = [
    'You help a blind user of a hardware wallet pick one person from a short list of contacts.',
    'The app gives you the list. Ask which person they mean, in one short question.',
    `When the user picks one, call ${TOOL_NAME} exactly once with that exact name from the list.`,
    `Never call ${TOOL_NAME} with a name that is not in the list. If unsure, ask again once.`,
    `If the user says cancel, stop, or none of them, say "Cancelled." and do not call ${TOOL_NAME}.`,
    'Never mention money, amounts, tokens, addresses or transactions. Keep every reply under 12 words.',
].join('\n');

export function toolConfig() {
    return {
        tool_config: {
            type: 'client',
            name: TOOL_NAME,
            description:
                'Call once with the exact name the user picked from the list. Never call it with a name not in the list.',
            expects_response: true,
            response_timeout_secs: 10,
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The exact contact name from the list.' },
                },
                required: ['name'],
            },
        },
    };
}

export function agentBody({ toolId, voiceId }) {
    const body = {
        name: AGENT_NAME,
        conversation_config: {
            agent: {
                first_message: 'Which contact did you mean?',
                language: 'en',
                prompt: { prompt: BASE_PROMPT, tool_ids: [toolId] },
            },
            conversation: { max_duration_seconds: 60 },
        },
        platform_settings: {
            auth: { enable_auth: true }, // a server-issued token is required (server/ /api/agent/token)
            overrides: {
                conversation_config_override: {
                    agent: { first_message: true, prompt: { prompt: true } },
                },
            },
        },
    };
    if (voiceId) {
        body.conversation_config.tts = { voice_id: voiceId };
    }
    return body;
}

/** Pure: which calls to make, given what exists. */
export function plan({ existingToolId, agentId }) {
    return {
        createTool: !existingToolId,
        agentAction: agentId ? 'update' : 'create',
    };
}

function redactor(key) {
    return (s) => (key && key.length >= 4 ? String(s).split(key).join('[redacted]') : String(s));
}

async function call(method, path, { key, body }) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'xi-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
        const hint =
            res.status === 401 || res.status === 403
                ? ' (the key needs the Agents / Conversational AI permission: ElevenLabs dashboard -> API keys -> edit)'
                : '';
        throw new Error(`${method} ${path} -> HTTP ${res.status}${hint}: ${redactor(key)(text.slice(0, 300))}`);
    }
    return text ? JSON.parse(text) : {};
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const dryRun = argv.includes('--dry-run');
    const unknown = argv.filter((a) => a !== '--dry-run');
    if (unknown.length) {
        console.log(`unknown argument: ${unknown.join(' ')}\nusage: node --env-file=server/.env tools/setup-agent.mjs [--dry-run]`);
        return 2;
    }
    const key = env.ELEVENLABS_API_KEY ?? '';
    const voiceId = env.ELEVENLABS_APP_VOICE_ID || env.ELEVENLABS_VOICE_ID || '';
    const agentId = env.ELEVENLABS_AGENT_ID || '';
    if (dryRun) {
        console.log('--dry-run: nothing is sent.\n\nclient tool:');
        console.log(JSON.stringify(toolConfig(), null, 2));
        console.log(`\nagent (${agentId ? `update ${agentId}` : 'create'}):`);
        console.log(JSON.stringify(agentBody({ toolId: '<tool id>', voiceId }), null, 2));
        return 0;
    }
    if (!key) {
        console.log('ELEVENLABS_API_KEY is not set: run with --env-file=server/.env');
        return 1;
    }
    const tools = await call('GET', '/v1/convai/tools', { key });
    const existing = (tools.tools ?? []).find((t) => t?.tool_config?.name === TOOL_NAME);
    const p = plan({ existingToolId: existing?.id, agentId });
    let toolId = existing?.id;
    if (p.createTool) {
        toolId = (await call('POST', '/v1/convai/tools', { key, body: toolConfig() })).id;
        console.log(`created client tool ${TOOL_NAME}: ${toolId}`);
    } else {
        console.log(`client tool ${TOOL_NAME} exists: ${toolId}`);
    }
    if (!toolId) {
        throw new Error('ElevenLabs returned no tool id');
    }
    const body = agentBody({ toolId, voiceId });
    if (p.agentAction === 'update') {
        await call('PATCH', `/v1/convai/agents/${encodeURIComponent(agentId)}`, { key, body });
        console.log(`updated agent ${agentId}`);
        return 0;
    }
    const created = await call('POST', '/v1/convai/agents/create', { key, body });
    if (!created.agent_id) {
        throw new Error('ElevenLabs returned no agent_id');
    }
    console.log(`created agent "${AGENT_NAME}". Add this line to server/.env, then restart the server:\n`);
    console.log(`ELEVENLABS_AGENT_ID=${created.agent_id}`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(
        (code) => process.exit(code),
        (e) => {
            console.log(`setup-agent failed: ${redactor(process.env.ELEVENLABS_API_KEY)(e?.message || e)}`);
            process.exit(1);
        },
    );
}
