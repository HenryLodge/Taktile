// Taktile companion app. The app is untrusted by design (docs/SECURITY_MODEL.md): the device parses
// every transaction itself and speaks the truth into its own earpiece. This app connects to the
// device or the simulator, turns typed or spoken commands into transactions, and speaks its own
// checksum of the bytes it built through the app voice (server/ text-to-speech).
// UI: React, two views without page reloads: home (/) = talk orb + conversation, /data = the rest.

import '@fontsource-variable/inter';
import './style.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initAnnounce, setVoice } from './announce.ts';
import { getDevice } from './connection.ts';
import { ContactBook } from './contacts.ts';
import { BrowserPlayer, Speaker, browserFallback } from './speech.ts';
import { log } from './state.ts';
import { App } from './ui/App.tsx';
import { autoReconnect } from './ui/connect-actions.ts';
import { route } from './ui/route.ts';
import { ControllersContext, type Controllers } from './ui/context.ts';
import type { DemoModule } from './ui/demo-types.ts';
import { startHealthPolling } from './ui/health.ts';
import { createSendController } from './ui/send-controller.ts';
import { statusLine } from './ui/store.ts';
import { createVoiceController, loadVoiceEnabled } from './ui/voice-controller.ts';

function byId(id: string): HTMLElement {
    const e = document.getElementById(id);
    if (e === null) {
        throw new Error(`missing #${id} in index.html`);
    }
    return e;
}

let voiceOn = loadVoiceEnabled();
const speaker = new Speaker({
    fetch: (input, init) => fetch(input, init),
    player: new BrowserPlayer(),
    fallback: browserFallback(),
    enabled: () => voiceOn,
    // the device speaks during every flow (PIN entry, announcement): wait until it is done
    mayStart: () => !(getDevice()?.client.flowRunning ?? false),
    onFallback: (reason) => log('app', `App voice unavailable (${reason}); using the browser voice.`),
});

// The live regions are static in index.html, outside React, so they exist before anything is said.
initAnnounce(byId('live-status'), byId('live-alert'), (text, level) => statusLine.set({ text, level }));
setVoice((text, priority) => void speaker.speak(text, priority));
startHealthPolling();

let storage: Storage | null = null;
try {
    storage = window.localStorage;
} catch {
    storage = null; // blocked: the contact list works in memory only
}
const book = new ContactBook(storage);
const send = createSendController(book, speaker);
const voice = createVoiceController(book, speaker, send, (on) => (voiceOn = on));
log('app', 'Ready. Connect the device over USB, or use the simulator.');

async function start(): Promise<void> {
    // DEMO ONLY: npm run demo sets VITE_TK_DEMO_MALWARE=1. In every other build this branch is dead code and
    // the module is not bundled (scripts/check-no-malware.mjs, part of npm run check, proves it). It is
    // installed before the silent USB reconnect, so its transport wrapper applies to that connection too.
    let demo: DemoModule | null = null;
    if (import.meta.env.VITE_TK_DEMO_MALWARE === '1') {
        demo = (await import('./ui/demo-malware.tsx')).installDemo();
    }
    const controllers: Controllers = { book, speaker, send, voice, demo };
    createRoot(byId('root')).render(
        <StrictMode>
            <ControllersContext.Provider value={controllers}>
                <App />
            </ControllersContext.Provider>
        </StrictMode>,
    );
    if (route.get().view !== 'pay') {
        await autoReconnect(); // the payer's page never touches a device
    }
}

void start();
