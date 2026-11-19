// Push-to-talk: Space held anywhere outside text fields, the talk orb (press to start, again to stop),
// Esc to stop the app voice, "Enable microphone", and the "Speak with app voice" setting.

import { alertUser, say } from '../announce.ts';
import type { ContactBook } from '../contacts.ts';
import type { Speaker } from '../speech.ts';
import { chat, log } from '../state.ts';
import { BrowserRecorder, PttController, VoiceError, earcon, transcribe, type PttState } from '../voice.ts';
import type { SendController } from './send-controller.ts';
import { createStore, type Store } from './store.ts';

const VOICE_KEY = 'tk.appVoice.v1';

export function loadVoiceEnabled(): boolean {
    try {
        return localStorage.getItem(VOICE_KEY) !== 'off';
    } catch {
        return true;
    }
}

export const PTT_LABEL: Record<PttState, string> = {
    idle: 'Hold Space to talk',
    arming: 'Opening the microphone…',
    recording: 'Listening… release Space to send',
    uploading: 'Transcribing…',
};

export interface VoiceState {
    ptt: PttState;
    hasMic: boolean;
    voiceOn: boolean;
}

export interface VoiceController {
    store: Store<VoiceState>;
    /** The open microphone stream, for the orb's level meter. */
    micStream(): MediaStream | null;
    toggle(): void;
    enableMic(): Promise<boolean>;
    setVoiceOn(on: boolean): void;
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

export function createVoiceController(
    book: ContactBook,
    speaker: Speaker,
    send: SendController,
    onVoiceOn: (on: boolean) => void,
): VoiceController {
    const recorder = new BrowserRecorder();
    const store = createStore<VoiceState>({ ptt: 'idle', hasMic: false, voiceOn: loadVoiceEnabled() });

    const ptt = new PttController({
        recorder,
        transcribe: (rec) =>
            transcribe(
                rec,
                book.list().map((c) => c.name),
            ),
        earcon,
        onState: (s) => {
            store.set({ ptt: s, hasMic: recorder.hasMic });
            if (s === 'recording') {
                speaker.stop(); // don't record the laptop's own voice
                say('Listening.');
            } else if (s === 'uploading') {
                say('Transcribing.');
            }
        },
        onTranscript: (text, canned) => {
            if (canned) {
                log('app', '(canned transcript from server/ in canned mode)');
            }
            void send.runCommand(text, 'voice');
        },
        onError: (e: VoiceError) => {
            log('error', e.message);
            chat('taktile', e.message, { level: 'alert' });
            alertUser(e.message, { voice: true });
            if (e.code !== 'too_short') {
                send.focus.input();
            }
        },
    });

    const busy = () => !send.acceptsVoice && ptt.state === 'idle';

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
        if (busy() && !info.repeat) {
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

    return {
        store,
        micStream: () => recorder.micStream,
        toggle() {
            if (busy()) {
                alertUser('Wait for the current send to finish.');
                return;
            }
            void ptt.toggle();
        },
        async enableMic() {
            try {
                await recorder.openMic();
                store.set({ hasMic: true });
                say('Microphone ready. Hold Space to talk.');
                return true;
            } catch (e) {
                const msg = e instanceof VoiceError ? e.message : String(e);
                log('error', msg);
                alertUser(msg);
                return false;
            }
        },
        setVoiceOn(on) {
            store.set({ voiceOn: on });
            onVoiceOn(on);
            try {
                localStorage.setItem(VOICE_KEY, on ? 'on' : 'off');
            } catch {
                // remembered for this page only
            }
            if (!on) {
                speaker.stop();
            }
            say(on ? 'App voice on.' : 'App voice off.');
        },
    };
}
