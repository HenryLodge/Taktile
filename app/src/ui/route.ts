// Two views in one page: home (/) and data (/data). Switching never reloads the page, so the open USB
// or simulator connection, the log and the app voice survive.

import { createStore } from './store.ts';

export type View = 'home' | 'data';

const viewOf = (path: string): View => (path.replace(/\/+$/, '') === '/data' ? 'data' : 'home');

export const route = createStore<{ view: View; /** true after a user navigation: move focus */ moved: boolean }>({
    view: viewOf(location.pathname),
    moved: false,
});

export const pathOf = (v: View): string => (v === 'data' ? '/data' : '/');

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
