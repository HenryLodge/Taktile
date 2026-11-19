// Both views stay mounted (hidden when not shown), so form text, the log scroll and the connection
// survive switching. Focus moves to the new view's heading after a navigation.

import { useEffect, useRef } from 'react';

import { DataPage } from './components/DataPage.tsx';
import { Home } from './components/Home.tsx';
import { useControllers } from './context.ts';
import { route } from './route.ts';
import { useStore } from './store.ts';

const TITLES = { home: 'Taktile', data: 'Data · Taktile' } as const;

export function App() {
    const { demo } = useControllers();
    const { view, moved } = useStore(route);
    const homeHeading = useRef<HTMLHeadingElement | null>(null);
    const dataHeading = useRef<HTMLHeadingElement | null>(null);

    useEffect(() => {
        // keep a "[…] " prefix another module put in front (the demo build marks itself there)
        const prefix = /^\[[^\]]*\] /.exec(document.title)?.[0] ?? '';
        document.title = prefix + TITLES[view];
        if (moved) {
            window.scrollTo(0, 0);
            (view === 'home' ? homeHeading : dataHeading).current?.focus();
        }
    }, [view, moved]);

    return (
        <>
            <a className="skip" href={view === 'home' ? '#main-home' : '#main-data'}>
                Skip to main content
            </a>
            {demo && <demo.Banner />}
            <div className="view view-home" hidden={view !== 'home'}>
                <Home ref={homeHeading} />
            </div>
            <div className="view view-data" hidden={view !== 'data'}>
                <DataPage ref={dataHeading} />
            </div>
        </>
    );
}
