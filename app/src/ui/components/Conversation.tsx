// The home page conversation: what the user said (right) and the app's key replies (left), plus one
// "working" bubble that follows the send flow's progress. Not a live region: announce.ts already
// announces these lines, so nothing is read twice. It is the untrusted laptop's view; the device's own
// voice in the earpiece is the truth.
//
// It scrolls inside its own area (the page itself stays one screen tall), like a chat app: new messages
// keep it at the bottom unless the user has scrolled up to read, and then a "Jump to latest" button
// appears. Anything the user says or types always brings it back to the bottom.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatEntry } from '../../state.ts';
import { useControllers } from '../context.ts';
import { reducedMotion, useAppState, useStore } from '../store.ts';
import { AlertIcon, ArrowDownIcon, CheckIcon, ExternalIcon } from './icons.tsx';
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

/** Within this many pixels of the bottom counts as "at the bottom" (keeps following new messages). */
const STICK_PX = 64;

export function Conversation() {
    const { chat } = useAppState();
    const { send } = useControllers();
    const s = useStore(send.store);
    const scroller = useRef<HTMLDivElement | null>(null);
    const stuck = useRef(true); // following the newest message
    const [showJump, setShowJump] = useState(false);
    const working = s.running && !s.asking && s.phase !== 'checksum' && s.phase !== 'done' && s.phase !== 'failed';
    const lastEntry = chat.at(-1);
    const last = lastEntry?.id;

    const toBottom = useCallback((smooth: boolean) => {
        const el = scroller.current;
        if (el === null) {
            return;
        }
        el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
        stuck.current = true;
        setShowJump(false);
    }, []);

    const onScroll = () => {
        const el = scroller.current;
        if (el === null) {
            return;
        }
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
        stuck.current = atBottom;
        if (atBottom) {
            setShowJump(false);
        }
    };

    // A new message (or the working bubble): follow it if the user was at the bottom, or if the
    // user just said something; otherwise offer the button instead of yanking the view down.
    useLayoutEffect(() => {
        if (last === undefined && !working) {
            return;
        }
        if (stuck.current || lastEntry?.role === 'user') {
            toBottom(true);
        } else {
            setShowJump(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- lastEntry changes with last
    }, [last, working, toBottom]);

    // Coming back to the home view (it stays mounted while hidden): show the newest messages.
    useEffect(() => {
        const el = scroller.current;
        if (el === null || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const ro = new ResizeObserver(() => {
            if (stuck.current) {
                el.scrollTop = el.scrollHeight;
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return (
        <section className="conversation" aria-labelledby="h-chat">
            <h2 id="h-chat" className="sr-only">
                Conversation (from this laptop, untrusted: the device's voice is the truth)
            </h2>
            <div
                ref={scroller}
                className="chat-scroll"
                onScroll={onScroll}
                // Keyboard users can scroll it with the arrow keys once it has focus.
                tabIndex={0}
                role="region"
                aria-label="Conversation messages"
            >
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
            </div>
            {showJump && (
                <button type="button" className="jump-latest" onClick={() => toBottom(true)}>
                    <ArrowDownIcon /> Jump to latest
                </button>
            )}
        </section>
    );
}
