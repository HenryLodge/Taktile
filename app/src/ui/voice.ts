// Push-to-talk UI: the talk button, Space anywhere outside text fields, Esc to stop the app voice,
// the "Enable microphone" button and the "Speak with app voice" toggle.

import { alertUser, say } from '../announce.ts';
import type { ContactBook } from '../contacts.ts';
import type { Speaker } from '../speech.ts';
import { log } from '../state.ts';
import { BrowserRecorder, PttController, VoiceError, earcon, transcribe, type PttState } from '../voice.ts';
import { el } from './dom.ts';
import type { SendUi } from './send.ts';

const VOICE_KEY = 'tk.appVoice.v1';

export function loadVoiceEnabled(): boolean {
    try {
        return localStorage.getItem(VOICE_KEY) !== 'off';
    } catch {
        return true;
    }
}

function inField(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) {
        return false;
    }
    if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) {
        return true;
    }
    return t instanceof HTMLInputElement; // text fields and checkboxes keep their own Space
}

const STATE_LABEL: Record<PttState, string> = {
    idle: 'Hold Space to talk',
    arming: 'Opening the microphone…',
    recording: 'Listening… release Space to send',
    uploading: 'Transcribing…',
};

export function initVoice(book: ContactBook, speaker: Speaker, send: SendUi, setVoiceOn: (on: boolean) => void): void {
    const talk = el<HTMLButtonElement>('btn-talk');
    const enableMic = el<HTMLButtonElement>('btn-mic');
    const voiceToggle = el<HTMLInputElement>('voice-toggle');
    const recorder = new BrowserRecorder();

    voiceToggle.checked = loadVoiceEnabled();
    voiceToggle.addEventListener('change', () => {
        setVoiceOn(voiceToggle.checked);
        try {
            localStorage.setItem(VOICE_KEY, voiceToggle.checked ? 'on' : 'off');
        } catch {
            // remembered for this page only
        }
        if (!voiceToggle.checked) {
            speaker.stop();
        }
        say(voiceToggle.checked ? 'App voice on.' : 'App voice off.');
    });

    const ptt = new PttController({
        recorder,
        transcribe: (rec) =>
            transcribe(
                rec,
                book.list().map((c) => c.name),
            ),
        earcon,
        onState: (s) => {
            talk.textContent = STATE_LABEL[s];
            talk.setAttribute('aria-pressed', String(s === 'recording' || s === 'arming'));
            if (s === 'recording') {
                speaker.stop(); // don't record the laptop's own voice
                say('Listening.');
            } else if (s === 'uploading') {
                say('Transcribing.');
            }
            enableMic.hidden = recorder.hasMic;
        },
        onTranscript: (text, canned) => {
            if (canned) {
                log('app', '(canned transcript from server/ in canned mode)');
            }
            void send.runCommand(text, 'voice');
        },
        onError: (e: VoiceError) => {
            log('error', e.message);
            alertUser(e.message, { voice: true });
            if (e.code !== 'too_short') {
                send.focusInput();
            }
        },
    });

    talk.addEventListener('click', () => {
        if (send.running) {
            alertUser('Wait for the current send to finish.');
            return;
        }
        void ptt.toggle();
    });

    enableMic.addEventListener('click', async () => {
        try {
            await recorder.openMic();
            enableMic.hidden = true;
            say('Microphone ready. Hold Space to talk.');
            talk.focus();
        } catch (e) {
            const msg = e instanceof VoiceError ? e.message : String(e);
            log('error', msg);
            alertUser(msg);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            speaker.stop();
            return;
        }
        if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey) {
            return;
        }
        const info = { key: e.key, repeat: e.repeat, inField: inField(e.target) };
        if (info.inField) {
            return;
        }
        e.preventDefault(); // no page scroll, no button click from Space
        if (send.running && !info.repeat && ptt.state === 'idle') {
            alertUser('Wait for the current send to finish.');
            return;
        }
        ptt.keydown(info);
    });
    document.addEventListener('keyup', (e) => {
        if (e.key !== ' ') {
            return;
        }
        const info = { key: e.key, repeat: false, inField: inField(e.target) };
        if (!info.inField) {
            e.preventDefault();
            ptt.keyup(info);
        }
    });
}
