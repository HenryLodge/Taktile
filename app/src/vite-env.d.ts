/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** "1" only in demo builds (npm run demo, app/.env.demo): enables the malware-mode toggle. */
    readonly VITE_TK_DEMO_MALWARE?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
