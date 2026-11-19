// The controllers the components use, created once in main.tsx.

import { createContext, useContext } from 'react';

import type { ContactBook } from '../contacts.ts';
import type { Speaker } from '../speech.ts';
import type { DemoModule } from './demo-types.ts';
import type { SendController } from './send-controller.ts';
import type { VoiceController } from './voice-controller.ts';

export interface Controllers {
    book: ContactBook;
    speaker: Speaker;
    send: SendController;
    voice: VoiceController;
    /** Demo builds only (npm run demo); null otherwise. */
    demo: DemoModule | null;
}

export const ControllersContext = createContext<Controllers | null>(null);

export function useControllers(): Controllers {
    const c = useContext(ControllersContext);
    if (c === null) {
        throw new Error('ControllersContext missing');
    }
    return c;
}
