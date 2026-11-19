// Taktile companion app. The app is untrusted by design (docs/SECURITY_MODEL.md): the device parses
// every transaction itself and speaks the truth into its own earpiece. This shell connects to the
// device or the simulator and shows what they report.

import './style.css';

import { initAnnounce } from './announce.ts';
import { ContactBook } from './contacts.ts';
import { log } from './state.ts';
import { initConnect } from './ui/connect.ts';
import { initDevice } from './ui/device.ts';
import { el } from './ui/dom.ts';
import { initLog } from './ui/log.ts';
import { initContacts } from './ui/contacts.ts';
import { initSend } from './ui/send.ts';
import { initServer } from './ui/server.ts';

initAnnounce(el('live-status'), el('live-alert'), el('status-line'));
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
initSend(book);
log('app', 'Ready. Connect the device over USB, or use the simulator.');
