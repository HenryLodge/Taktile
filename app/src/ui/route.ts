// Views in one page: home (/), data (/data), and Taktile Pay (/pay, the payer's page, opened on its
// own). Switching never reloads the page, so the open USB or simulator connection, the log and the app
// voice survive.

import { createStore } from './store.ts';

export type View = 'home' | 'data' | 'pay';

const viewOf = (path: string): View => {
    const p = path.replace(/\/+$/, '');
    return p === '/data' ? 'data' : p === '/pay' ? 'pay' : 'home';
};

export const route = createStore<{ view: View; /** true after a user navigation: move focus */ moved: boolean }>({
    view: viewOf(location.pathname),
    moved: false,
});

export const pathOf = (v: View): string => (v === 'data' ? '/data' : v === 'pay' ? '/pay' : '/');

export function navigate(view: View): void {
    if (location.pathname !== pathOf(view)) {
        history.pushState(null, '', pathOf(view));
    }
    route.set({ view, moved: true });
}

window.addEventListener('popstate', () => {
    const view = viewOf(location.pathname);
    if (view !== route.get().view) {
        route.set({ view, moved: true }); // an in-page #section link also fires popstate: ignore those
    }
});
