// The home page conversation: what the user said (right) and the app's key replies (left), plus one
// "working" bubble that follows the send flow's progress. Not a live region: announce.ts already
// announces these lines, so nothing is read twice. It is the untrusted laptop's view; the device's own
// voice in the earpiece is the truth.

import { useEffect, useRef } from 'react';

import type { ChatEntry } from '../../state.ts';
import { useControllers } from '../context.ts';
import { reducedMotion, useAppState, useStore } from '../store.ts';
import { AlertIcon, CheckIcon, ExternalIcon } from './icons.tsx';
import { CopyField } from './CopyField.tsx';

function ChecksumBubble({ m }: { m: ChatEntry }) {
    const lead = m.text.replace(/\s*Checksum:.*$/, '');
    return (
        <li className="bubble bubble-taktile bubble-checksum">
            <span className="sr-only">Taktile: </span>
            <span className="bubble-eyebrow">App checksum</span>
            <span className="sr-only">{m.text}</span>
            <span className="words" aria-hidden="true">
                {m.words?.map((w, i) => (
                    <span className="word" key={i}>
                        {w}
                    </span>
                ))}
            </span>
            <span className="bubble-sub" aria-hidden="true">
                {lead}
            </span>
            <span className="bubble-note">Your device should say the same three words.</span>
        </li>
    );
}

function Bubble({ m }: { m: ChatEntry }) {
    if (m.words && m.words.length > 0) {
        return <ChecksumBubble m={m} />;
    }
    const kind = m.role === 'user' ? 'user' : m.level === 'alert' ? 'alert' : m.link ? 'done' : 'taktile';
    return (
        <li className={`bubble bubble-${m.role} bubble-kind-${kind}`}>
            <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Taktile: '}</span>
            {kind === 'alert' && (
                <span className="bubble-icon">
                    <AlertIcon />
                </span>
            )}
            {kind === 'done' && (
                <span className="bubble-icon">
                    <CheckIcon />
                </span>
            )}
            <span className="bubble-text">{m.text}</span>
            {m.copy !== undefined && <CopyField label={m.copy.label} value={m.copy.value} />}
            {m.link !== undefined && (
                <a className="bubble-link" href={m.link} target="_blank" rel="noopener">
                    View on Solana Explorer (devnet) <ExternalIcon />
                    <span className="sr-only"> (opens in a new tab)</span>
                </a>
            )}
        </li>
    );
}

export function Conversation() {
    const { chat } = useAppState();
    const { send } = useControllers();
    const s = useStore(send.store);
    const end = useRef<HTMLDivElement | null>(null);
    const working = s.running && !s.asking && s.phase !== 'checksum' && s.phase !== 'done' && s.phase !== 'failed';
    const last = chat.at(-1)?.id;

    useEffect(() => {
        const el = end.current;
        if (el !== null && el.offsetParent !== null) {
            el.scrollIntoView({ block: 'end', behavior: reducedMotion() ? 'auto' : 'smooth' });
        }
    }, [last, working]);

    return (
        <section className="conversation" aria-labelledby="h-chat">
            <h2 id="h-chat" className="sr-only">
                Conversation (from this laptop, untrusted: the device's voice is the truth)
            </h2>
            {chat.length === 0 ? (
                <div className="chat-empty">
                    <p>Try saying</p>
                    <p className="chat-example">“Send 0.01 SOL to Henry”</p>
                    <p className="chat-example">“Pay 1 USDC to Henry”</p>
                </div>
            ) : (
                <ol className="chat">
                    {chat.map((m) => (
                        <Bubble key={m.id} m={m} />
                    ))}
                    {working && (
                        <li className="bubble bubble-taktile bubble-working" aria-hidden="true">
                            <span className="dots">
                                <span />
                                <span />
                                <span />
                            </span>
                            <span className="bubble-text">{s.phaseText || 'Working…'}</span>
                        </li>
                    )}
                </ol>
            )}
            <div ref={end} />
        </section>
    );
}
