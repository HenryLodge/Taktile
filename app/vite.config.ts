import { defineConfig } from 'vite';

// localhost only: the simulator (ws://localhost:8765) and server/ (127.0.0.1:8787) accept only
// http://localhost / 127.0.0.1 pages, and Web Serial needs a secure context (localhost counts).
export default defineConfig({
    server: {
        host: 'localhost',
        port: 5173,
        strictPort: true,
        proxy: { '/api': 'http://127.0.0.1:8787' },
    },
    preview: { host: 'localhost', port: 5173, strictPort: true },
    build: { target: 'es2022' },
});
