#!/usr/bin/env node
// Prepare Solana DEVNET for the demo (docs/TASKS.md Day 5-7). Safe to run again and again: it only
// does what is missing.
//
//   node tools/setup-devnet.mjs --device <address> [--contact Henry=<address> ...] [--dry-run]
//
// 1. A setup payer keypair in tools/out/setup-payer.keypair.json (gitignored). It pays the rent for
//    the token accounts below: the device cannot (it signs only the two transfer shapes, SOLANA.md).
// 2. Airdrops 1 SOL to the payer and to the device when either has less than 0.05 SOL. The devnet
//    faucet is rate-limited; when it refuses, use https://faucet.solana.com with the printed address.
// 3. Creates the devnet-USDC associated token accounts of the device, each contact and the demo
//    attacker (malware mode, M6), in one transaction, skipping any that exist.
// 4. Prints SOL and USDC balances. Devnet USDC itself comes only from Circle's faucet, a web page with a
//    reCAPTCHA (manual): https://faucet.circle.com -> Solana Devnet -> the device address (20 USDC
//    per request, one request every 2 hours).
//
// DEVNET ONLY (SECURITY_MODEL I9): the RPC endpoint is a constant and its genesis hash is checked.
// Nothing secret is printed; the payer's secret key stays in its file.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { CONSTANTS } from './gen-consts.mjs';

export const DEVNET_RPC = 'https://api.devnet.solana.com'; // deliberately not configurable (I9)
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const AIRDROP_BELOW = 0.05 * LAMPORTS_PER_SOL;
export const AIRDROP_AMOUNT = 1 * LAMPORTS_PER_SOL;
export const ATA_RENT_ESTIMATE = 2_100_000; // ~0.00204 SOL rent-exempt token account, rounded up
export const LOW_USDC = 5_000_000n; // 5 USDC
export const ATTACKER_LABEL = 'taktile-demo:attacker';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAYER_PATH = join(HERE, 'out', 'setup-payer.keypair.json');

const pinned = Object.fromEntries(CONSTANTS.map((c) => [c.name, new PublicKey(c.base58)]));
export const TOKEN_PROGRAM = pinned.TK_TOKEN_PROGRAM_ID;
export const ATA_PROGRAM = pinned.TK_ATA_PROGRAM_ID;
export const USDC_MINT = pinned.TK_DEVNET_USDC_MINT;

const USAGE = 'usage: node tools/setup-devnet.mjs --device <address> [--contact NAME=<address> ...] [--dry-run]';

/** The demo attacker (malware mode): a public label, devnet only. Its key is not a secret. */
export function attacker() {
    return Keypair.fromSeed(createHash('sha256').update(ATTACKER_LABEL).digest()).publicKey;
}

export const usdcAta = (owner) => getAssociatedTokenAddressSync(USDC_MINT, owner, false, TOKEN_PROGRAM, ATA_PROGRAM);

function address(text, what) {
    let key;
    try {
        key = new PublicKey(text);
    } catch {
        throw new Error(`${what}: not a Solana address: ${text}`);
    }
    if (key.toBase58() !== text) {
        throw new Error(`${what}: not a Solana address: ${text}`);
    }
    if (!PublicKey.isOnCurve(key.toBytes())) {
        throw new Error(`${what}: ${text} is not a wallet address (it looks like a token account or other program address)`);
    }
    return key;
}

export function parseArgs(argv) {
    let device = null;
    const contacts = [];
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') {
            dryRun = true;
        } else if (a === '--device' || a === '--contact') {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) {
                throw new Error(`${a} needs a value\n${USAGE}`);
            }
            if (a === '--device') {
                device = address(v, '--device');
            } else {
                const eq = v.indexOf('=');
                const name = v.slice(0, eq);
                if (eq < 1 || !/^[A-Za-z0-9 '-]{1,12}$/.test(name)) {
                    throw new Error(`--contact wants NAME=ADDRESS (name: 1-12 letters, digits, space, - or '): ${v}`);
                }
                contacts.push({ name, wallet: address(v.slice(eq + 1), `--contact ${name}`) });
            }
        } else {
            throw new Error(`unknown argument: ${a}\n${USAGE}`);
        }
    }
    if (device === null) {
        throw new Error(`--device is required\n${USAGE}`);
    }
    return { device, contacts, dryRun };
}

/**
 * Pure: what to do, given what exists. state = { payerLamports, deviceLamports, accounts: [{label,
 * owner, ata, exists}] }. Returns { airdrops: [{label, address}], create: [account], payerShort }.
 */
export function planActions(state) {
    const airdrops = [];
    if (state.payerLamports < AIRDROP_BELOW) {
        airdrops.push({ label: 'setup payer', key: 'payer' });
    }
    if (state.deviceLamports < AIRDROP_BELOW) {
        airdrops.push({ label: 'device', key: 'device' });
    }
    const seen = new Set();
    const create = state.accounts.filter((a) => {
        const k = a.ata.toBase58();
        const fresh = !a.exists && !seen.has(k);
        seen.add(k);
        return fresh;
    });
    const payerNeeds = create.length * ATA_RENT_ESTIMATE + 10_000;
    return { airdrops, create, payerNeeds };
}

const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
const usdc = (units) => (units === null ? 'no account' : `${Number(units) / 1e6} USDC`);
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

function loadPayer() {
    if (existsSync(PAYER_PATH)) {
        return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, 'utf8'))));
    }
    const kp = Keypair.generate();
    mkdirSync(dirname(PAYER_PATH), { recursive: true });
    writeFileSync(PAYER_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.log(`created the setup payer: ${PAYER_PATH} (gitignored; devnet only)`);
    return kp;
}

async function tokenBalance(conn, ata) {
    if ((await conn.getAccountInfo(ata, 'confirmed')) === null) {
        return null;
    }
    return BigInt((await conn.getTokenAccountBalance(ata, 'confirmed')).value.amount);
}

async function survey(conn, payer, owners) {
    const accounts = [];
    for (const o of owners) {
        const ata = usdcAta(o.owner);
        const units = await tokenBalance(conn, ata);
        accounts.push({ ...o, ata, exists: units !== null, units });
    }
    return {
        payerLamports: await conn.getBalance(payer.publicKey, 'confirmed'),
        deviceLamports: await conn.getBalance(owners[0].owner, 'confirmed'),
        accounts,
    };
}

function printTable(state, payer) {
    console.log('\n  who          SOL              USDC account                                   USDC');
    const row = (label, lamports, a) =>
        console.log(
            `  ${label.padEnd(12)} ${(lamports === null ? '-' : sol(lamports)).padEnd(16)} ${(a ? a.ata.toBase58() : '-').padEnd(46)} ${a ? usdc(a.units) : ''}`,
        );
    row('setup payer', state.payerLamports, null);
    for (const a of state.accounts) {
        row(a.label, a.label === 'device' ? state.deviceLamports : null, a);
    }
    console.log(`\n  device address: ${state.accounts[0].owner.toBase58()}`);
    console.log(`  payer address:  ${payer.publicKey.toBase58()}\n`);
}

async function airdrop(conn, who, key) {
    try {
        const sig = await conn.requestAirdrop(key, AIRDROP_AMOUNT);
        const bh = await conn.getLatestBlockhash('confirmed');
        await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
        console.log(`airdropped ${sol(AIRDROP_AMOUNT)} to the ${who}: ${explorer('tx', sig)}`);
        return true;
    } catch (e) {
        console.log(
            `the devnet faucet refused the airdrop to the ${who} (${String(e.message ?? e).slice(0, 120)}).\n` +
                `  Use https://faucet.solana.com (devnet) with: ${key.toBase58()}`,
        );
        return false;
    }
}

export async function main(argv = process.argv.slice(2)) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        console.log(e.message);
        return 2;
    }
    const conn = new Connection(DEVNET_RPC, 'confirmed');
    const genesis = await conn.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
        console.log(`refusing: ${DEVNET_RPC} is not devnet (genesis ${genesis})`);
        return 1;
    }
    const payer = args.dryRun && !existsSync(PAYER_PATH) ? Keypair.generate() : loadPayer();
    const owners = [
        { label: 'device', owner: args.device },
        ...args.contacts.map((c) => ({ label: c.name, owner: c.wallet })),
        { label: 'attacker', owner: attacker() },
    ];
    let state = await survey(conn, payer, owners);
    const plan = planActions(state);
    printTable(state, payer);

    if (plan.airdrops.length === 0 && plan.create.length === 0) {
        console.log('nothing to do: SOL is there and every USDC account exists.');
    } else {
        console.log('to do:');
        for (const a of plan.airdrops) {
            console.log(`  airdrop ${sol(AIRDROP_AMOUNT)} to the ${a.label}`);
        }
        for (const c of plan.create) {
            console.log(`  create the USDC account of ${c.label}: ${c.ata.toBase58()}`);
        }
        if (args.dryRun) {
            console.log('\n--dry-run: nothing was sent.');
            return 0;
        }
        for (const a of plan.airdrops) {
            await airdrop(conn, a.label, a.key === 'payer' ? payer.publicKey : args.device);
        }
        if (plan.create.length > 0) {
            const have = await conn.getBalance(payer.publicKey, 'confirmed');
            if (have < plan.payerNeeds) {
                console.log(
                    `\nthe setup payer has ${sol(have)} but needs about ${sol(plan.payerNeeds)} to create the accounts.\n` +
                        `  Fund it at https://faucet.solana.com (devnet): ${payer.publicKey.toBase58()}\n  then run this again.`,
                );
                return 1;
            }
            const tx = new Transaction();
            for (const c of plan.create) {
                tx.add(
                    createAssociatedTokenAccountIdempotentInstruction(
                        payer.publicKey,
                        c.ata,
                        c.owner,
                        USDC_MINT,
                        TOKEN_PROGRAM,
                        ATA_PROGRAM,
                    ),
                );
            }
            const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
            console.log(`created ${plan.create.length} USDC account(s): ${explorer('tx', sig)}`);
        }
        state = await survey(conn, payer, owners);
        printTable(state, payer);
    }

    const device = state.accounts[0];
    if (device.units === null || device.units < LOW_USDC) {
        console.log(
            'The device needs devnet USDC (manual, it has a reCAPTCHA):\n' +
                '  1. open https://faucet.circle.com\n' +
                '  2. network: Solana Devnet\n' +
                `  3. address: ${args.device.toBase58()}\n` +
                '  4. send 20 USDC (one request per 2 hours; request again later for a buffer)\n' +
                (device.exists ? '' : '  Create its USDC account first (run this without --dry-run).\n'),
        );
    }
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(
        (code) => process.exit(code),
        (e) => {
            console.log(`setup-devnet failed: ${e?.message || e?.name || e}`);
            process.exit(1);
        },
    );
}
