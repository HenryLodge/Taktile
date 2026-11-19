// /data: everything except push-to-talk and the conversation. A section index on wide screens.

import { forwardRef } from 'react';

import { useControllers } from '../context.ts';
import { navigate } from '../route.ts';
import { ConnectionBadge } from './ConnectionBadge.tsx';
import { ConnectionPanel } from './ConnectionPanel.tsx';
import { ContactsPanel } from './ContactsPanel.tsx';
import { DevicePanel } from './DevicePanel.tsx';
import { ArrowLeftIcon, Logo } from './icons.tsx';
import { KeysPanel, LogPanel } from './LogPanel.tsx';
import { PhrasePanel } from './PhrasePanel.tsx';
import { SendPanel } from './SendPanel.tsx';

const SECTIONS: [id: string, label: string][] = [
    ['sec-connection', 'Connection'],
    ['sec-send', 'Send'],
    ['sec-contacts', 'Contacts'],
    ['sec-phrase', 'Address phrase'],
    ['sec-device', 'Device'],
    ['sec-log', 'Log'],
    ['sec-keys', 'Keyboard'],
];

export const DataPage = forwardRef<HTMLHeadingElement>(function DataPage(_props, heading) {
    const { demo } = useControllers();
    return (
        <>
            <header className="topbar">
                <a
                    className="navlink"
                    href="/"
                    onClick={(e) => {
                        e.preventDefault();
                        navigate('home');
                    }}
                >
                    <ArrowLeftIcon /> Back to talk
                </a>
                <span className="brand">
                    <Logo size={24} />
                    <span className="brand-name" aria-hidden="true">
                        Taktile
                    </span>
                </span>
                <ConnectionBadge />
            </header>

            <div className="data-layout">
                <nav className="toc" aria-label="Sections">
                    <ul>
                        {SECTIONS.map(([id, label]) => (
                            <li key={id}>
                                <a
                                    href={`#${id}`}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        const target = document.getElementById(id);
                                        target?.scrollIntoView({ block: 'start' });
                                        document.getElementById(`${id}-h`)?.focus({ preventScroll: true });
                                    }}
                                >
                                    {label}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>

                <main id="main-data" className="data">
                    <div className="data-intro">
                        <h1 ref={heading} tabIndex={-1}>
                            Data
                        </h1>
                        <p className="panel-lead">
                            Companion app for the Taktile hardware wallet. Solana devnet only. Push-to-talk is on the
                            home page; <kbd>Space</kbd> works here too.
                        </p>
                    </div>
                    {demo && <demo.Panel />}
                    <ConnectionPanel />
                    <SendPanel />
                    <ContactsPanel />
                    <PhrasePanel />
                    <DevicePanel />
                    <LogPanel />
                    <KeysPanel />
                </main>
            </div>
        </>
    );
});
