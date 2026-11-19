// Taktile companion app. The app is untrusted by design (docs/SECURITY_MODEL.md): the device parses
// every transaction itself and speaks the truth into its own earpiece. This app connects to the
// device or the simulator, turns typed or spoken commands into transactions, and speaks its own
// checksum of the bytes it built through the app voice (server/ text-to-speech).

import './style.css';

import { initAnnounce, setVoice } from './announce.ts';
import { ContactBook } from './contacts.ts';
import { BrowserPlayer, Speaker, browserFallback } from './speech.ts';
import { getDevice } from './connection.ts';
import { log } from './state.ts';
import { initConnect } from './ui/connect.ts';
import { initContacts } from './ui/contacts.ts';
import { initDevice } from './ui/device.ts';
import { el } from './ui/dom.ts';
import { initLog } from './ui/log.ts';
import { initPhrase } from './ui/phrase.ts';
import { initSend } from './ui/send.ts';
import { initServer } from './ui/server.ts';
import { initVoice, loadVoiceEnabled } from './ui/voice.ts';

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

initAnnounce(el('live-status'), el('live-alert'), el('status-line'));
setVoice((text, interrupt) => void speaker.speak(text, interrupt ? 'interrupt' : 'normal'));
initLog();
initConnect();
initDevice();
initServer();

let storage: Storage | null = null;
try {
    storage = window.localStorage;
} catch {
    storage = null; // blocked: the contact list works in memory only
}
const book = new ContactBook(storage);
initContacts(book, () => undefined);
const send = initSend(book, speaker);
initVoice(book, speaker, send, (on) => (voiceOn = on));
initPhrase(speaker);
log('app', 'Ready. Connect the device over USB, or use the simulator.');

// DEMO ONLY: npm run demo sets VITE_TK_DEMO_MALWARE=1. In every other build this branch is dead code and
// the malware module is not bundled (scripts/check-no-malware.mjs, part of npm run check, proves it).
if (import.meta.env.VITE_TK_DEMO_MALWARE === '1') {
    void import('./ui/malware.ts').then((m) => m.initMalware());
}
