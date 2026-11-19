// Home (/): the talk orb and the conversation. Everything else lives on /data.

import { forwardRef } from 'react';

import { navigate } from '../route.ts';
import { statusLine, useAppState, useStore } from '../store.ts';
import { ConnectionBadge } from './ConnectionBadge.tsx';
import { Conversation } from './Conversation.tsx';
import { GridIcon, Logo } from './icons.tsx';
import { Orb } from './Orb.tsx';

export const Home = forwardRef<HTMLHeadingElement>(function Home(_props, heading) {
    const { connection } = useAppState();
    const line = useStore(statusLine);

    return (
        <>
            <header className="topbar">
                <span className="brand">
                    <Logo />
                    <span className="brand-name" aria-hidden="true">
                        Taktile
                    </span>
                </span>
                <nav className="topnav" aria-label="Pages">
                    <ConnectionBadge />
                    <a
                        className="navlink"
                        href="/data"
                        onClick={(e) => {
                            e.preventDefault();
                            navigate('data');
                        }}
                    >
                        <GridIcon /> Data
                    </a>
                </nav>
            </header>

            <main id="main-home" className="home">
                <h1 ref={heading} className="sr-only" tabIndex={-1}>
                    Taktile
                </h1>
                <section className="stage" aria-label="Talk">
                    <Orb />
                    <p className={`status-line status-${line.level}`} aria-hidden="true">
                        {line.text}
                    </p>
                    {connection.status === 'disconnected' && (
                        <p className="offline">
                            Not connected.{' '}
                            <a
                                href="/data"
                                onClick={(e) => {
                                    e.preventDefault();
                                    navigate('data');
                                }}
                            >
                                Connect on the Data page
                            </a>
                        </p>
                    )}
                </section>
                <Conversation />
            </main>
        </>
    );
});
