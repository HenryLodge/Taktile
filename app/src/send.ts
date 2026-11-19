// The send flow, in the order firmware/tools/sign_devnet.py proved on devnet:
//
//   balance check -> HELLO -> UNLOCK if locked (PIN on the device) -> fresh blockhash (it lives ~60 s,
//   so only after the PIN) -> build the message + app checksum -> SIGN_REQUEST (announcement, CONFIRM on
//   the device) -> verify the signature -> blockhash still valid? -> broadcast -> wait for confirmation.
//
// Nothing is broadcast unless the device returned OK with a signature that verifies over exactly the
// bytes we built. Every step is reported (screen + live region) through `report`.

import { formatAmount, DECIMALS } from './amount.ts';
import { txPhrase } from './checksum.ts';
import type { Intent } from './intent.ts';
import type { DeviceClient } from './proto/client.ts';
import { DEVICE_STATE, STATUS, eventText, statusText } from './proto/codes.ts';
import { base58 } from './proto/base58.ts';
import type { Rpc } from './rpc.ts';
import {
    EXPLORER_TX,
    FEE_LAMPORTS,
    signedTransaction,
    solTransferMessage,
    usdcAta,
    usdcTransferMessage,
    verifySignature,
} from './tx.ts';
import { PublicKey } from '@solana/web3.js';

export type SendIntent = Extract<Intent, { kind: 'send' }>;

export type ReportLevel = 'info' | 'alert';
export interface Report {
    phase: SendPhase;
    text: string;
    level: ReportLevel;
}
export type SendPhase =
    | 'checking'
    | 'unlocking'
    | 'building'
    | 'checksum'
    | 'device'
    | 'broadcasting'
    | 'confirming'
    | 'done'
    | 'failed';

export interface SendDeps {
    client: DeviceClient;
    pubkey: Uint8Array;
    rpc: Rpc;
    /** UNLOCK on the device; resolves with the status, or null if the request failed. */
    unlock: () => Promise<number | null>;
    report: (r: Report) => void;
    sleep?: (ms: number) => Promise<void>;
    confirmTimeoutMs?: number;
    pollMs?: number;
}

export type SendOutcome =
    | { ok: true; signature: string; explorer: string; confirmed: boolean; appPhrase: string[] }
    | { ok: false; reason: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sol = (lamports: bigint) => `${formatAmount(lamports, DECIMALS.SOL)} SOL`;
const usdcText = (units: bigint) => `${formatAmount(units, DECIMALS.USDC)} USDC`;

export async function runSend(intent: SendIntent, d: SendDeps): Promise<SendOutcome> {
    const sleep = d.sleep ?? defaultSleep;
    const fail = (text: string, level: ReportLevel = 'alert'): SendOutcome => {
        d.report({ phase: 'failed', text, level });
        return { ok: false, reason: text };
    };
    const info = (phase: SendPhase, text: string) => d.report({ phase, text, level: 'info' });

    if (d.client.flowRunning) {
        return fail('Wait for the current request on the device to finish.');
    }
    const to = new PublicKey(intent.contact.address).toBytes();
    if (base58(to) === base58(d.pubkey)) {
        return fail('That address is the device itself.');
    }
    const usdc = intent.token === 'USDC';
    const amount = intent.amount;
    const what = `${formatAmount(amount, DECIMALS[intent.token])} ${intent.token} to ${intent.contact.name}`;

    let sent: { sig: string; appPhrase: string[] } | null = null;
    try {
        // 1. Will it fail on-chain anyway? (Not a limit: the device would sign, devnet would refuse.)
        info('checking', `Sending ${what}.`);
        const have = await d.rpc.balance(d.pubkey);
        const needSol = usdc ? FEE_LAMPORTS : amount + FEE_LAMPORTS;
        if (have < needSol) {
            return fail(`Not enough SOL on the device: it has ${sol(have)}, this send needs ${sol(needSol)}.`);
        }
        if (usdc) {
            const mine = await d.rpc.tokenBalance(usdcAta(d.pubkey));
            if (mine === null || mine < amount) {
                const has = mine === null ? 'no USDC account yet' : `${usdcText(mine)}`;
                return fail(
                    `Not enough USDC on the device: it has ${has}, this send needs ${usdcText(amount)}.${
                        mine === null ? ' Run tools/setup-devnet.mjs and the Circle faucet.' : ''
                    }`,
                );
            }
            if ((await d.rpc.tokenBalance(usdcAta(to))) === null) {
                return fail(
                    `${intent.contact.name} has no USDC account yet, so this would fail on devnet. Run tools/setup-devnet.mjs for ${intent.contact.name}.`,
                );
            }
        }

        // 2. PIN first, so the blockhash below is fresh when the device signs.
        const h = await d.client.hello();
        if (h.state === DEVICE_STATE.NO_WALLET) {
            return fail(statusText(STATUS.NO_WALLET));
        }
        if (h.state === DEVICE_STATE.LOCKED) {
            info('unlocking', 'Unlocking. Enter your PIN on the device.');
            const st = await d.unlock();
            if (st !== STATUS.OK) {
                return fail(st === null ? 'Unlock failed. Nothing was sent.' : `${statusText(st)} Nothing was sent.`);
            }
        }

        // 3. Build.
        info('building', 'Getting a fresh blockhash from devnet.');
        const bh = await d.rpc.latestBlockhash();
        const message = usdc
            ? usdcTransferMessage(d.pubkey, to, amount, bh.blockhash)
            : solTransferMessage(d.pubkey, to, amount, bh.blockhash);
        const appPhrase = await txPhrase(message);
        info('checksum', `App checksum: ${appPhrase.join(' ')}. The device should say the same three words.`);

        // 4. The device announces, the user confirms there.
        const { status, signature } = await d.client.signRequest(message, (e) => info('device', eventText(e)));
        if (status !== STATUS.OK || signature === null) {
            const tail = status === STATUS.REJECTED_BY_USER || status === STATUS.CANCELLED ? ' Nothing was sent.' : '';
            return fail(`${statusText(status)}${tail}`, status === STATUS.CANCELLED ? 'info' : 'alert');
        }
        if (!(await verifySignature(d.pubkey, message, signature))) {
            return fail("The device's signature did not verify. Nothing was sent.");
        }

        // 5. Broadcast, if the blockhash is still valid.
        const height = await d.rpc.blockHeight();
        if (height > bh.lastValidBlockHeight) {
            return fail('Too slow: the blockhash expired before the device signed. Nothing was sent. Try again.');
        }
        info('broadcasting', 'Signed. Sending to devnet.');
        const sig = base58(signature);
        const txid = await d.rpc.sendRaw(signedTransaction(signature, message));
        sent = { sig, appPhrase };
        if (txid !== sig) {
            info('broadcasting', `Note: devnet returned transaction ID ${txid}, expected ${sig}.`);
        }

        // 6. Confirmation.
        info('confirming', 'Sent. Waiting for devnet to confirm.');
        const deadline = (d.confirmTimeoutMs ?? 60_000) / (d.pollMs ?? 1500);
        for (let i = 0; i < deadline; i++) {
            const st = await d.rpc.signatureStatus(sig);
            if (st.state === 'confirmed') {
                d.report({ phase: 'done', text: `Confirmed: sent ${what}.`, level: 'info' });
                return { ok: true, signature: sig, explorer: EXPLORER_TX(sig), confirmed: true, appPhrase };
            }
            if (st.state === 'failed') {
                return fail(`Devnet rejected the transaction: ${st.error}`);
            }
            await sleep(d.pollMs ?? 1500);
        }
        d.report({ phase: 'done', text: 'Sent, but not confirmed yet. Check the explorer link.', level: 'info' });
        return { ok: true, signature: sig, explorer: EXPLORER_TX(sig), confirmed: false, appPhrase };
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (sent !== null) {
            // Broadcast already happened: never claim nothing was sent.
            d.report({
                phase: 'done',
                text: `Sent, but checking confirmation failed (${m}). Check the explorer link.`,
                level: 'info',
            });
            return {
                ok: true,
                signature: sent.sig,
                explorer: EXPLORER_TX(sent.sig),
                confirmed: false,
                appPhrase: sent.appPhrase,
            };
        }
        return fail(`Send failed: ${m}`);
    }
}
