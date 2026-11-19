// The talk orb: push-to-talk as one big button. Hold Space (anywhere outside text fields), or press it
// to start and again to stop. While recording it turns dark green and follows the microphone level
// (an AnalyserNode on the open mic stream, read only in this browser). Reduced motion: color + label.

import { useEffect, useRef, type RefObject } from 'react';

import type { PttState } from '../../voice.ts';
import { useControllers } from '../context.ts';
import { focusTargets } from '../focus.ts';
import { reducedMotion, useStore } from '../store.ts';
import { PTT_LABEL } from '../voice-controller.ts';
import { MicIcon } from './icons.tsx';

function useMicLevel(target: RefObject<HTMLElement | null>, active: boolean, stream: () => MediaStream | null) {
    const audio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; stream: MediaStream } | null>(null);

    useEffect(() => {
        const el = target.current;
        if (!active || el === null || reducedMotion() || typeof AudioContext === 'undefined') {
            return;
        }
        const s = stream();
        if (s === null) {
            return;
        }
        try {
            if (audio.current?.stream !== s) {
                const ctx = audio.current?.ctx ?? new AudioContext();
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 1024;
                ctx.createMediaStreamSource(s).connect(analyser); // not to the speakers: no echo
                audio.current = { ctx, analyser, stream: s };
            }
            void audio.current.ctx.resume();
        } catch {
            return; // no meter; the orb still changes color
        }
        const { analyser } = audio.current;
        const buf = new Float32Array(analyser.fftSize);
        let level = 0;
        let frame = 0;
        const tick = () => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const x of buf) {
                sum += x * x;
            }
            const rms = Math.sqrt(sum / buf.length);
            // speech RMS is roughly 0.01 (quiet) to 0.2 (loud): map to 0..1, rise fast, fall slowly
            const t = Math.min(1, Math.max(0, (rms - 0.008) * 6));
            level += (t - level) * (t > level ? 0.45 : 0.1);
            el.style.setProperty('--level', level.toFixed(3));
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(frame);
            el.style.setProperty('--level', '0');
        };
    }, [active, target, stream]);
}

const HINT: Record<PttState, string> = {
    idle: 'or press Enter on the orb',
    arming: 'one moment',
    recording: 'speak now',
    uploading: 'one moment',
};

export function Orb() {
    const { voice } = useControllers();
    const { ptt } = useStore(voice.store);
    const ref = useRef<HTMLButtonElement | null>(null);
    useMicLevel(ref, ptt === 'recording', voice.micStream);

    return (
        <div className="orb-wrap">
            <button
                ref={(el) => {
                    ref.current = el;
                    focusTargets.talk = el;
                }}
                type="button"
                className="orb"
                data-state={ptt}
                aria-pressed={ptt === 'recording' || ptt === 'arming'}
                aria-describedby="talk-help"
                onClick={() => voice.toggle()}
            >
                <span className="orb-halo" aria-hidden="true" />
                <span className="orb-ring" aria-hidden="true" />
                <span className="orb-core" aria-hidden="true">
                    <MicIcon size={34} />
                </span>
                <span className="sr-only">{PTT_LABEL[ptt]}</span>
            </button>
            <p className="orb-label" aria-hidden="true">
                {ptt === 'idle' ? (
                    <>
                        Hold <kbd>Space</kbd> to talk
                    </>
                ) : (
                    PTT_LABEL[ptt]
                )}
            </p>
            <p className="orb-hint" aria-hidden="true">
                {HINT[ptt]}
            </p>
            <p id="talk-help" className="sr-only">
                Hold Space anywhere except in a text field, say a command, release. Or press Enter on this button to
                start, and again to stop.
            </p>
        </div>
    );
}
