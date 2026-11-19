// Typed commands and the voice settings. The same path as push-to-talk (send-controller.ts).

import { useEffect, useRef } from 'react';

import { cancelOnDevice } from '../../connection.ts';
import { useControllers } from '../context.ts';
import { useAppState, useStore } from '../store.ts';
import { Button } from './Button.tsx';
import { ExternalIcon, MicIcon } from './icons.tsx';
import { Panel } from './Panel.tsx';

export function SendPanel() {
    const { send, voice } = useControllers();
    const s = useStore(send.store);
    const v = useStore(voice.store);
    const { connection: c } = useAppState();
    const input = useRef<HTMLInputElement | null>(null);
    const result = useRef<HTMLAnchorElement | null>(null);
    const ready = c.status === 'connected' && c.deviceState !== null && c.deviceState !== 0;

    useEffect(() => {
        const visible = (e: HTMLElement | null) => e !== null && e.offsetParent !== null;
        send.setFocusTargets({
            input: () => {
                if (visible(input.current)) {
                    input.current?.focus();
                }
            },
            result: () => {
                // the link renders on the next commit
                requestAnimationFrame(() => {
                    if (visible(result.current)) {
                        result.current?.focus();
                    }
                });
            },
        });
    }, [send]);

    useEffect(() => {
        if (s.asking && input.current?.offsetParent) {
            input.current.focus(); // a typed answer works too
        }
    }, [s.asking]);

    return (
        <Panel
            id="sec-send"
            title="Send"
            lead="Type a command, or hold Space anywhere outside a text field and say it."
            aside={
                s.running ? (
                    <span className="chip chip-live">Sending</span>
                ) : s.asking ? (
                    <span className="chip chip-live">Waiting for your answer</span>
                ) : undefined
            }
        >
            <form
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    void send.runCommand(s.command, 'typed');
                }}
            >
                <label htmlFor="send-command">Command</label>
                <div className="field-row">
                    <input
                        ref={input}
                        id="send-command"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="send 0.01 SOL to Henry"
                        aria-describedby="send-hint"
                        aria-disabled={s.running && !s.asking}
                        readOnly={s.running && !s.asking}
                        value={s.command}
                        onChange={(e) => send.setCommand(e.target.value)}
                    />
                    <Button type="submit" variant="primary" enabled={(ready && !s.running) || s.asking}>
                        {s.asking ? 'Answer' : 'Send'}
                    </Button>
                    <Button variant="ghost" enabled={s.running} onPress={cancelOnDevice}>
                        Cancel on device
                    </Button>
                </div>
                <p id="send-hint" className="hint">
                    For example: send 0.01 SOL to Henry. $5 or 5 dollars means USDC.
                </p>
            </form>

            {(s.summary || s.phaseText) && (
                <div className="flow">
                    {s.summary && <p className="flow-summary">{s.summary}</p>}
                    {s.checksum && (
                        <p className="flow-checksum">
                            <span className="flow-label">App checksum</span>
                            <span className="words">
                                {s.checksum.map((w, i) => (
                                    <span className="word" key={i}>
                                        {w}
                                    </span>
                                ))}
                            </span>
                        </p>
                    )}
                    {s.phaseText && <p className={`flow-phase flow-${s.phaseLevel}`}>{s.phaseText}</p>}
                    {s.explorer && (
                        <a ref={result} className="flow-link" href={s.explorer} target="_blank" rel="noopener">
                            View on Solana Explorer (devnet) <ExternalIcon />
                            <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                    )}
                </div>
            )}

            <div className="settings">
                <h3 className="settings-title">Voice</h3>
                {!v.hasMic && (
                    <Button size="sm" icon={<MicIcon size={16} />} onPress={() => void voice.enableMic()}>
                        Enable microphone
                    </Button>
                )}
                <label className="switch">
                    <input
                        type="checkbox"
                        role="switch"
                        checked={v.voiceOn}
                        onChange={(e) => voice.setVoiceOn(e.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                    Speak with app voice
                </label>
                <label className="switch">
                    <input
                        type="checkbox"
                        role="switch"
                        checked={s.agentOn}
                        onChange={(e) => send.setAgent(e.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                    Use the ElevenLabs assistant for questions
                </label>
            </div>
        </Panel>
    );
}
