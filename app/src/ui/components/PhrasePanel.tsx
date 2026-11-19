// "My address phrase": the contact's side of enrollment. Anyone enters their own wallet address and
// gets the same 8 words the adding device reads aloud (SHA-256("TK-ADDR-v1" || address), PGP words;
// docs/AUDIO.md). They read the words over the phone; the person adding them compares with the device.
// The phrase is public (SECURITY_MODEL, decided 2026-11-18): it comes from a public address.

import { PublicKey } from '@solana/web3.js';
import { useRef, useState } from 'react';

import { alertUser, say } from '../../announce.ts';
import { addressPhrase } from '../../checksum.ts';
import { getDevice } from '../../connection.ts';
import { validAddress } from '../../contacts.ts';
import { log } from '../../state.ts';
import { useControllers } from '../context.ts';
import { useAppState } from '../store.ts';
import { Button } from './Button.tsx';
import { Panel } from './Panel.tsx';

export function PhrasePanel() {
    const { speaker } = useControllers();
    const { connection } = useAppState();
    const [address, setAddress] = useState('');
    const [error, setError] = useState('');
    const [words, setWords] = useState<string[]>([]);
    const input = useRef<HTMLInputElement | null>(null);
    const read = useRef<HTMLButtonElement | null>(null);
    const deviceSpeaking = getDevice()?.client.flowRunning ?? false;

    async function show(): Promise<void> {
        const a = address.trim();
        if (!validAddress(a)) {
            const msg = 'Paste a Solana wallet address (base58).';
            setError(msg);
            alertUser(msg);
            input.current?.focus();
            setWords([]);
            return;
        }
        setError('');
        const w = await addressPhrase(new PublicKey(a).toBytes());
        setWords(w);
        const msg = `Address phrase: ${w.join(', ')}.`;
        log('app', `${msg} (for ${a.slice(0, 4)}…${a.slice(-4)})`);
        say(msg);
        requestAnimationFrame(() => read.current?.focus());
    }

    return (
        <Panel
            id="sec-phrase"
            title="My address phrase"
            lead="For the person adding you: their device reads 8 words made from your address. Read these words to them over the phone; they must match word for word."
        >
            <form
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    void show();
                }}
            >
                <label htmlFor="phrase-address">Your wallet address</label>
                <div className="field-row">
                    <input
                        ref={input}
                        id="phrase-address"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="phrase-error"
                        aria-invalid={error ? true : undefined}
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                    />
                    <Button
                        variant="ghost"
                        enabled={connection.address !== null}
                        onPress={() => {
                            setAddress(connection.address ?? '');
                            input.current?.focus();
                        }}
                    >
                        Use this device's address
                    </Button>
                </div>
                <p id="phrase-error" className="error">
                    {error}
                </p>
                <div className="btn-row">
                    <Button type="submit" variant="primary">
                        Show my phrase
                    </Button>
                    <Button
                        ref={read}
                        enabled={words.length > 0 && !deviceSpeaking}
                        onPress={() => {
                            if (getDevice()?.client.flowRunning) {
                                alertUser('The device is speaking; read the words when it is done.');
                                return;
                            }
                            void speaker.speak(`Address phrase: ${words.join(', ')}.`, 'interrupt');
                        }}
                    >
                        Read aloud
                    </Button>
                </div>
            </form>
            {words.length > 0 && (
                <ol className="phrase" aria-label="Address phrase">
                    {words.map((w, i) => (
                        <li key={i}>
                            <span className="phrase-n" aria-hidden="true">
                                {i + 1}
                            </span>
                            {w}
                        </li>
                    ))}
                </ol>
            )}
        </Panel>
    );
}
