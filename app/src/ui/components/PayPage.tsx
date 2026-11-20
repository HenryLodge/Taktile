// /pay: Taktile Pay, the payer's page (docs/EXTRATASKS.md Part 2 B2). Max opens it in his own browser
// profile with Solflare set to devnet and presses "Connect Solflare". From then on every payment request
// addressed to his wallet appears here and Solflare's approval window pops up by itself; if Solflare
// needs a click first, the request's Pay button gets the focus, so Enter opens it.

import { PublicKey } from '@solana/web3.js';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';

import { alertUser, say } from '../../announce.ts';
import { addressPhrase } from '../../checksum.ts';
import {
    PayError,
    connectWallet,
    fetchAction,
    findSolflare,
    isRejection,
    payRequest,
    rememberWallet,
    waitForSolflare,
    walletRemembered,
    type ActionView,
    type WalletProvider,
} from '../../pay.ts';
import { RequestsError, amountText, listRequests, type PayRequest } from '../../requests.ts';
import { EXPLORER_TX } from '../../tx.ts';
import { earcon } from '../../voice.ts';
import { Button } from './Button.tsx';
import { CopyField } from './CopyField.tsx';
import { Logo } from './icons.tsx';
import { Panel } from './Panel.tsx';

type Phase = 'loading' | 'ready' | 'asking' | 'sent' | 'paid' | 'declined' | 'error';

interface Item {
    req: PayRequest;
    action: ActionView | null;
    phrase: string[];
    phase: Phase;
    text: string;
    /** The automatic Solflare prompt was tried; from now on only the Pay button starts it. */
    tried: boolean;
    signature: string | null;
}

const POLL_MS = 3000;
const fetchApi = (input: string, init?: RequestInit) => fetch(input, init);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function storage(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export const PayPage = forwardRef<HTMLHeadingElement>(function PayPage(_props, heading) {
    const [address, setAddress] = useState<string | null>(null);
    const [status, setStatus] = useState('');
    const [, setVersion] = useState(0);
    const items = useRef(new Map<string, Item>());
    const wallet = useRef<WalletProvider | null>(null);
    const busy = useRef(false);
    const payButtons = useRef(new Map<string, HTMLButtonElement>());
    const rerender = useCallback(() => setVersion((v) => v + 1), []);

    const update = useCallback(
        (id: string, patch: Partial<Item>) => {
            const it = items.current.get(id);
            if (it !== undefined) {
                items.current.set(id, { ...it, ...patch });
                rerender();
            }
        },
        [rerender],
    );

    const pay = useCallback(
        async (id: string): Promise<void> => {
            const it = items.current.get(id);
            const w = wallet.current;
            if (it === undefined || w === null || address === null || busy.current) {
                return;
            }
            busy.current = true;
            update(id, { phase: 'asking', tried: true, text: 'Approve or reject in the Solflare window.' });
            try {
                const sig = await payRequest(fetchApi, w, address, it.req, it.action ?? undefined);
                update(id, { phase: 'sent', signature: sig, text: 'Paid. Waiting for devnet to confirm.' });
                say(`Sent ${amountText(it.req)}. Waiting for devnet to confirm.`, { voice: true });
            } catch (e) {
                if (isRejection(e)) {
                    update(id, { phase: 'declined', text: 'Not paid: rejected in Solflare.' });
                    say('Not paid.', { voice: true });
                } else {
                    const m = e instanceof PayError ? e.message : e instanceof Error ? e.message : String(e);
                    const hint = /blockhash|network|cluster/i.test(m) ? ' Check that Solflare is set to devnet.' : '';
                    update(id, { phase: 'error', text: `${m}${hint} Press Pay to try again.` });
                    alertUser(`Payment request from ${it.req.requesterName}: ${m}${hint} Press Pay to try again.`, {
                        voice: true,
                    });
                    requestAnimationFrame(() => payButtons.current.get(id)?.focus());
                }
            } finally {
                busy.current = false;
            }
        },
        [address, update],
    );

    // Poll for requests addressed to this wallet; the first new one prompts Solflare by itself.
    useEffect(() => {
        if (address === null) {
            return undefined;
        }
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            try {
                const rs = await listRequests(fetchApi, { payer: address });
                setStatus('');
                for (const r of rs) {
                    const it = items.current.get(r.id);
                    if (it === undefined) {
                        if (r.status !== 'pending') {
                            continue;
                        }
                        items.current.set(r.id, {
                            req: r,
                            action: null,
                            phrase: [],
                            phase: 'loading',
                            text: 'Loading…',
                            tried: false,
                            signature: null,
                        });
                        rerender();
                        try {
                            const [action, phrase] = await Promise.all([
                                fetchAction(fetchApi, `/api/actions/request/${r.id}`),
                                addressPhrase(new PublicKey(r.recipient).toBytes()),
                            ]);
                            update(r.id, { action, phrase, phase: 'ready', text: '' });
                            earcon('start');
                            say(`Payment request from ${r.requesterName}: ${amountText(r)}.`, { voice: true });
                        } catch (e) {
                            const m = e instanceof Error ? e.message : String(e);
                            update(r.id, { phase: 'error', tried: true, text: `${m} Press Pay to try again.` });
                        }
                    } else if (r.status === 'paid' && it.phase !== 'paid') {
                        update(r.id, { req: r, phase: 'paid', signature: r.signature, text: 'Paid.' });
                        say(`Payment confirmed: ${amountText(r)} to ${r.requesterName}.`, { voice: true });
                    } else if (r.status === 'expired' && it.phase !== 'paid') {
                        update(r.id, { req: r, phase: 'declined', text: 'Expired.' });
                    }
                }
                // One automatic Solflare prompt per request, oldest first.
                const next = [...items.current.values()]
                    .filter((i) => i.phase === 'ready' && !i.tried)
                    .sort((a, b) => a.req.createdAt - b.req.createdAt)[0];
                if (next !== undefined && !busy.current) {
                    void pay(next.req.id);
                }
            } catch (e) {
                setStatus(e instanceof RequestsError || e instanceof PayError ? e.message : String(e));
            }
            if (!stopped) {
                timer = setTimeout(() => void tick(), POLL_MS);
            }
        };
        void tick();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [address, pay, update, rerender]);

    // After a reload: reconnect by itself if this profile connected before (and Solflare agrees).
    useEffect(() => {
        if (!walletRemembered(storage())) {
            return undefined;
        }
        let cancelled = false;
        setStatus('Reconnecting Solflare…');
        void (async () => {
            const w = await waitForSolflare(window);
            if (cancelled) {
                return;
            }
            if (w === null) {
                setStatus('Solflare did not load. Reload the page, or press Connect Solflare.');
                return;
            }
            try {
                const a = await connectWallet(w);
                if (!cancelled) {
                    wallet.current = w;
                    setAddress(a);
                    setStatus('');
                    say(`Reconnected ${short(a)}. Waiting for payment requests.`);
                }
            } catch {
                rememberWallet(storage(), false); // revoked or another wallet: ask again
                if (!cancelled) {
                    setStatus('Solflare did not reconnect. Press Connect Solflare.');
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    async function disconnect(): Promise<void> {
        rememberWallet(storage(), false);
        const w = wallet.current;
        wallet.current = null;
        items.current.clear();
        setAddress(null);
        try {
            await w?.disconnect?.();
        } catch {
            // already disconnected
        }
        say('Disconnected. This page will not reconnect Solflare by itself.');
    }

    async function connect(): Promise<void> {
        const w = findSolflare(window);
        if (w === null) {
            const msg =
                'Solflare is not installed in this browser. Install the Solflare extension, set it to devnet, then reload this page.';
            setStatus(msg);
            alertUser(msg);
            return;
        }
        try {
            const a = await connectWallet(w);
            wallet.current = w;
            setAddress(a);
            setStatus('');
            rememberWallet(storage(), true);
            say(`Connected ${short(a)}. Waiting for payment requests.`);
        } catch (e) {
            const msg = isRejection(e)
                ? 'Not connected: rejected in Solflare.'
                : `Could not connect Solflare: ${e instanceof Error ? e.message : String(e)}`;
            setStatus(msg);
            alertUser(msg);
        }
    }

    const list = [...items.current.values()].sort((a, b) => b.req.createdAt - a.req.createdAt);

    return (
        <>
            <header className="topbar">
                <span className="brand">
                    <Logo size={24} />
                    <span className="brand-name">Taktile Pay</span>
                </span>
            </header>
            <main id="main-pay" className="data">
                <div className="data-intro">
                    <h1 ref={heading} tabIndex={-1}>
                        Taktile Pay
                    </h1>
                    <p className="panel-lead">
                        Pay requests from people who use a Taktile wallet. Solana devnet only. Each request is a Solana
                        Action (the protocol behind Blinks); your Solflare wallet signs, and nothing is paid until you
                        approve it there.
                    </p>
                </div>

                <Panel
                    id="sec-wallet"
                    title="Your wallet"
                    lead={
                        address === null
                            ? 'Connect Solflare (set to devnet). Requests addressed to your wallet then appear here and open in Solflare by themselves.'
                            : undefined
                    }
                >
                    {address === null ? (
                        <Button variant="primary" onPress={connect}>
                            Connect Solflare
                        </Button>
                    ) : (
                        <>
                            <p>
                                Connected: <span className="addr">{address}</span>
                            </p>
                            <p className="hint">This page reconnects Solflare by itself after a reload.</p>
                            <Button variant="ghost" size="sm" onPress={disconnect}>
                                Disconnect
                            </Button>
                        </>
                    )}
                    {status !== '' && (
                        <p className="error" role="status">
                            {status}
                        </p>
                    )}
                </Panel>

                {address !== null && (
                    <Panel id="sec-requests" title="Payment requests">
                        {list.length === 0 ? (
                            <p className="empty">
                                No payment requests for this wallet yet. This page checks every few seconds.
                            </p>
                        ) : (
                            <ul className="contact-list">
                                {list.map((it) => (
                                    <li key={it.req.id} className="contact">
                                        <div className="contact-main">
                                            <h3 className="contact-name">
                                                {it.action?.title ?? `Payment request from ${it.req.requesterName}`}
                                            </h3>
                                            <p>
                                                <strong>{amountText(it.req)}</strong> to{' '}
                                                <span className="addr">{it.req.recipient}</span>
                                            </p>
                                            {it.phrase.length > 0 && (
                                                <p>
                                                    Requester&apos;s address phrase:{' '}
                                                    <strong>{it.phrase.join(' ')}</strong>. Ask them to say &quot;what
                                                    is my address&quot; on their Taktile device; the 8 words must match.
                                                </p>
                                            )}
                                            {it.req.blink !== undefined && (
                                                <CopyField label="Copy Blink link" value={it.req.blink} />
                                            )}
                                            {it.text !== '' && (
                                                <p className={it.phase === 'error' ? 'error' : 'hint'}>{it.text}</p>
                                            )}
                                            {(it.phase === 'sent' || it.phase === 'paid') && it.signature !== null && (
                                                <p>
                                                    <a
                                                        href={EXPLORER_TX(it.signature)}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        View on Solana Explorer (devnet)
                                                    </a>
                                                </p>
                                            )}
                                        </div>
                                        {(it.phase === 'ready' || it.phase === 'error' || it.phase === 'declined') &&
                                            it.req.status === 'pending' && (
                                                <div className="contact-actions">
                                                    <Button
                                                        ref={(b) => {
                                                            if (b === null) {
                                                                payButtons.current.delete(it.req.id);
                                                            } else {
                                                                payButtons.current.set(it.req.id, b);
                                                            }
                                                        }}
                                                        variant="primary"
                                                        onPress={() => pay(it.req.id)}
                                                    >
                                                        {it.action?.label ?? `Pay ${amountText(it.req)}`}
                                                    </Button>
                                                </div>
                                            )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Panel>
                )}
            </main>
        </>
    );
});
