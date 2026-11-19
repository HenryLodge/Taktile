// Connect device (USB), Use simulator, Disconnect, and the speech service line.

import { useEffect, useRef, useState } from 'react';

import { disconnect } from '../../connection.ts';
import { grantedPort, webSerialSupported } from '../../transport/webserial.ts';
import { connectFromUi } from '../connect-actions.ts';
import { focusIfVisible } from '../focus.ts';
import { healthText } from '../health.ts';
import { useAppState } from '../store.ts';
import { Button } from './Button.tsx';
import { ChipIcon, UsbIcon } from './icons.tsx';
import { Panel } from './Panel.tsx';

export function ConnectionPanel() {
    const { connection: c, server } = useAppState();
    const supported = webSerialSupported();
    const [granted, setGranted] = useState(false);
    const usb = useRef<HTMLButtonElement | null>(null);
    const sim = useRef<HTMLButtonElement | null>(null);
    const idle = c.status === 'disconnected';

    useEffect(() => {
        if (supported) {
            void grantedPort().then((p) => setGranted(p !== null));
        }
    }, [supported, c.status]);

    // Unplugged or the sim went away: focus goes back to where the user can reconnect.
    useEffect(() => {
        const onLost = (e: Event) => {
            const kind = (e as CustomEvent<{ kind: string }>).detail.kind;
            focusIfVisible(kind === 'sim' ? sim.current : usb.current);
        };
        document.addEventListener('tk-disconnected', onLost);
        return () => document.removeEventListener('tk-disconnected', onLost);
    }, []);

    const serverState = server === null ? 'checking' : server === 'offline' ? 'offline' : server.mode;

    return (
        <Panel id="sec-connection" title="Connection">
            <div className="btn-row">
                <Button
                    ref={usb}
                    variant="primary"
                    icon={<UsbIcon />}
                    enabled={idle && supported}
                    onPress={() => connectFromUi('usb')}
                >
                    {granted ? 'Reconnect device (USB)' : 'Connect device (USB)'}
                </Button>
                <Button ref={sim} icon={<ChipIcon />} enabled={idle} onPress={() => connectFromUi('sim')}>
                    Use simulator
                </Button>
                <Button
                    variant="ghost"
                    enabled={c.status === 'connected'}
                    onPress={async () => {
                        const kind = c.kind;
                        await disconnect();
                        focusIfVisible(kind === 'sim' ? sim.current : usb.current);
                    }}
                >
                    Disconnect
                </Button>
            </div>
            {!supported && (
                <p className="note">USB needs Chrome or Edge (Web Serial). The simulator works in any browser.</p>
            )}
            <div className="service" data-state={serverState}>
                <span className="badge-dot" aria-hidden="true" />
                <span>
                    <strong>Speech service:</strong> {healthText(server)}
                </span>
            </div>
        </Panel>
    );
}
