// The connection pill in the top bar: link, and whether the wallet is locked. Text, not color alone.

import { DEVICE_STATE } from '../../proto/codes.ts';
import { useAppState } from '../store.ts';
import { LockIcon } from './icons.tsx';

export function ConnectionBadge() {
    const { connection: c } = useAppState();
    const link = c.kind === 'sim' ? 'Simulator' : 'Device';
    let text = 'Not connected';
    if (c.status === 'connecting') {
        text = 'Connecting…';
    } else if (c.status === 'connected') {
        text =
            c.deviceState === DEVICE_STATE.UNLOCKED
                ? `${link} · Unlocked`
                : c.deviceState === DEVICE_STATE.LOCKED
                  ? `${link} · Locked`
                  : `${link} · No wallet`;
    }
    return (
        <span className="badge" data-status={c.status}>
            <span className="badge-dot" aria-hidden="true" />
            {c.status === 'connected' && c.deviceState !== DEVICE_STATE.NO_WALLET && (
                <LockIcon open={c.deviceState === DEVICE_STATE.UNLOCKED} />
            )}
            <span>
                <span className="sr-only">Connection: </span>
                {text}
                {c.activity ? ` · ${c.activity}` : ''}
            </span>
        </span>
    );
}
