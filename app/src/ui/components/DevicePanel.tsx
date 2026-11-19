// Device: state, address, firmware, contact count; Unlock and Cancel.

import { alertUser, say } from '../../announce.ts';
import { STATE_TEXT, cancelOnDevice, unlock } from '../../connection.ts';
import { DEVICE_STATE } from '../../proto/codes.ts';
import { useAppState } from '../store.ts';
import { Button } from './Button.tsx';
import { CopyIcon } from './icons.tsx';
import { Panel } from './Panel.tsx';

export function DevicePanel() {
    const { connection: c } = useAppState();
    const connected = c.status === 'connected';
    const state =
        c.status === 'connecting'
            ? 'Connecting…'
            : connected && c.deviceState !== null
              ? `${STATE_TEXT[c.deviceState]}${c.activity ? ` (${c.activity})` : ''}`
              : 'Not connected';

    return (
        <Panel id="sec-device" title="Device">
            <dl className="facts">
                <div>
                    <dt>State</dt>
                    <dd>{state}</dd>
                </div>
                <div>
                    <dt>Firmware</dt>
                    <dd>{c.fw !== null ? String(c.fw) : '—'}</dd>
                </div>
                <div>
                    <dt>Contacts on the device</dt>
                    <dd>{c.contacts !== null ? String(c.contacts) : '—'}</dd>
                </div>
                <div className="facts-wide">
                    <dt>Wallet address</dt>
                    <dd className="addr">
                        <code>{c.address ?? '—'}</code>
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={<CopyIcon />}
                            enabled={c.address !== null}
                            onPress={async () => {
                                try {
                                    await navigator.clipboard.writeText(c.address ?? '');
                                    say('Address copied.');
                                } catch {
                                    alertUser('Could not copy. Select the address and copy it.');
                                }
                            }}
                        >
                            Copy address
                        </Button>
                    </dd>
                </div>
            </dl>
            <div className="btn-row">
                <Button
                    variant="primary"
                    enabled={connected && c.deviceState === DEVICE_STATE.LOCKED && c.activity === null}
                    onPress={unlock}
                >
                    Unlock on device
                </Button>
                <Button variant="ghost" enabled={connected} onPress={cancelOnDevice}>
                    Cancel on device
                </Button>
            </div>
        </Panel>
    );
}
