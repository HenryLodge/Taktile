#!/usr/bin/env node
// Build Solana legacy messages with web3.js / spl-token and write the parser and ATA test vectors.
//
//   node tools/gen-vectors.mjs           write tests/vectors/{parser,ata,curve,checksum,contacts,seed}.json and core/tests/gen/*.h
//   node tools/gen-vectors.mjs --check   write nothing; exit 1 if any committed file is stale
//
// Needs `cd tools && npm ci` once. Never touches the network: it only builds messages.
// Wallets come from public labels ("taktile-vector:<label>"); only public keys are written.

import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createTransferCheckedInstruction,
    createTransferInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
    Keypair,
    Message,
    MessageV0,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';

import { CONSTANTS } from './gen-consts.mjs';
import { loadWords } from './gen-words.mjs';

const MAX_MESSAGE_LEN = 1232; // docs/SOLANA.md

// Must list tk_parse_result_t in core/include/tk_parser.h, in order, without the TK_PARSE_ prefix.
export const PARSE_REASONS = [
    'OK',
    'TOO_LARGE', 'TRUNCATED', 'VERSIONED', 'BAD_COMPACT_U16', 'TRAILING_BYTES',
    'BAD_HEADER', 'FEE_PAYER', 'DUPLICATE_KEY', 'INSTRUCTION_COUNT', 'INDEX_OUT_OF_RANGE', 'UNSUPPORTED_PROGRAM',
    'SOL_LAYOUT', 'SOL_FROM_NOT_DEVICE',
    'TOKEN_LAYOUT', 'TOKEN_WRONG_MINT', 'TOKEN_WRONG_DECIMALS', 'TOKEN_WRONG_SOURCE', 'TOKEN_OWNER_NOT_DEVICE',
];
const U64_MAX = (1n << 64n) - 1n;

// ---- Pinned constants: always the same values as tk_solana_consts.h ----

const pinned = Object.fromEntries(CONSTANTS.map((c) => [c.name, new PublicKey(c.base58)]));
const SYSTEM_PROGRAM = pinned.TK_SYSTEM_PROGRAM_ID;
const TOKEN_PROGRAM = pinned.TK_TOKEN_PROGRAM_ID;
const ATA_PROGRAM = pinned.TK_ATA_PROGRAM_ID;
const USDC_MINT = pinned.TK_DEVNET_USDC_MINT;
const USDC_DECIMALS = 6;

if (!SYSTEM_PROGRAM.equals(SystemProgram.programId)) {
    throw new Error('gen-consts System Program differs from web3.js');
}

// ---- Deterministic test inputs ----

export function wallet(label) {
    const seed = createHash('sha256').update(`taktile-vector:${label}`).digest();
    return Keypair.fromSeed(seed).publicKey;
}

const DEVICE = wallet('device');
const ALICE = wallet('alice');
const BOB = wallet('bob');
const CAROL = wallet('carol');
const MALLORY = wallet('mallory');
const FAKE_MINT = wallet('fake-mint');
const BLOCKHASH = new PublicKey(createHash('sha256').update('taktile-vector:blockhash').digest()).toBase58();

const usdcAta = (owner) => getAssociatedTokenAddressSync(USDC_MINT, owner, false, TOKEN_PROGRAM, ATA_PROGRAM);
const DEVICE_ATA = usdcAta(DEVICE);
const ALICE_ATA = usdcAta(ALICE);
const MALLORY_ATA = usdcAta(MALLORY);

// ---- Message building ----

function legacy(instructions, feePayer = DEVICE) {
    const tx = new Transaction({ feePayer, recentBlockhash: BLOCKHASH });
    tx.add(...instructions);
    return Buffer.from(tx.compileMessage().serialize());
}

const solTransfer = (lamports, from = DEVICE, to = ALICE) =>
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

const usdcTransfer = (amount, opts = {}) =>
    createTransferCheckedInstruction(
        opts.source ?? DEVICE_ATA,
        opts.mint ?? USDC_MINT,
        opts.destination ?? ALICE_ATA,
        opts.owner ?? DEVICE,
        amount,
        opts.decimals ?? USDC_DECIMALS,
        [],
        opts.programId ?? TOKEN_PROGRAM,
    );

// Copy an instruction, optionally replacing its keys or data. web3.js still frames it correctly.
function rebuild(ix, { keys, data } = {}) {
    return new TransactionInstruction({
        programId: ix.programId,
        keys: keys ?? ix.keys,
        data: data ?? ix.data,
    });
}

// ---- Legacy message layout walker (records every field's offset) ----

export function readCompactU16(buf, off) {
    let value = 0;
    for (let i = 0; i < 3; i++) {
        if (off + i >= buf.length) {
            throw new Error('compact-u16 runs past the buffer');
        }
        const b = buf[off + i];
        value |= (b & 0x7f) << (7 * i);
        if ((b & 0x80) === 0) {
            return { value, size: i + 1 };
        }
    }
    throw new Error('compact-u16 longer than 3 bytes');
}

export function encodeCompactU16(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new Error('compact-u16 out of range');
    }
    const out = [];
    let v = value;
    for (;;) {
        const b = v & 0x7f;
        v >>= 7;
        if (v === 0) {
            out.push(b);
            return Buffer.from(out);
        }
        out.push(b | 0x80);
    }
}

// Walks a well-formed legacy message with exactly one instruction (the generator only walks its
// own valid messages). Returns the fields in order, each { name, start, end }.
export function walkLegacy(buf) {
    const fields = [];
    let off = 0;
    const field = (name, size) => {
        if (off + size > buf.length) {
            throw new Error(`${name} runs past the buffer`);
        }
        fields.push({ name, start: off, end: off + size });
        off += size;
        return off - size;
    };
    const compact = (name) => {
        const { value, size } = readCompactU16(buf, off);
        field(name, size);
        return value;
    };

    field('num_required_signatures', 1);
    field('num_readonly_signed_accounts', 1);
    field('num_readonly_unsigned_accounts', 1);
    const n = compact('num_account_keys');
    const keys = [];
    for (let i = 0; i < n; i++) {
        keys.push(buf.subarray(field(`account_keys[${i}]`, 32), off));
    }
    field('recent_blockhash', 32);
    const m = compact('num_instructions');
    if (m !== 1) {
        throw new Error('walker expects exactly one instruction');
    }
    const programIdIndex = buf[field('program_id_index', 1)];
    const k = compact('num_accounts');
    const accounts = [];
    for (let i = 0; i < k; i++) {
        accounts.push(buf[field(`account_index[${i}]`, 1)]);
    }
    const l = compact('data_len');
    const dataStart = field('data', l);
    if (off !== buf.length) {
        throw new Error('trailing bytes after the instruction');
    }
    return { fields, keys, programIdIndex, accounts, data: buf.subarray(dataStart, off) };
}

const fieldOf = (layout, name) => {
    const f = layout.fields.find((x) => x.name === name);
    if (!f) {
        throw new Error(`no field ${name}`);
    }
    return f;
};

// Replace bytes at an offset without changing the length; asserts nothing else moved.
function patch(base, offset, bytes) {
    const out = Buffer.from(base);
    Buffer.from(bytes).copy(out, offset);
    let changed = 0;
    for (let i = 0; i < out.length; i++) {
        if (out[i] !== base[i]) {
            if (i < offset || i >= offset + bytes.length) {
                throw new Error('patch changed bytes outside its range');
            }
            changed++;
        }
    }
    if (changed === 0) {
        throw new Error('patch changed nothing');
    }
    return out;
}

// Replace the bytes of [start, end) with `bytes` (length may differ).
const splice = (base, start, end, bytes) =>
    Buffer.concat([base.subarray(0, start), Buffer.from(bytes), base.subarray(end)]);

// ---- Vectors ----

const hex = (b) => Buffer.from(b).toString('hex');

function u64le(buf) {
    return Buffer.from(buf).readBigUInt64LE(0);
}

// Independent read-back of every OK vector: web3.js round trip plus our walker.
function selfCheckOk(v, expectProgram, expectDest, expectAmount) {
    const bytes = Buffer.from(v.message_hex, 'hex');
    const parsed = Message.from(bytes);
    if (!Buffer.from(parsed.serialize()).equals(bytes)) {
        throw new Error(`${v.name}: web3.js round trip differs`);
    }
    const lay = walkLegacy(bytes);
    if (!lay.keys[lay.programIdIndex].equals(expectProgram.toBuffer())) {
        throw new Error(`${v.name}: wrong program`);
    }
    const destIdx = lay.accounts[expectProgram.equals(SYSTEM_PROGRAM) ? 1 : 2];
    if (!lay.keys[destIdx].equals(expectDest.toBuffer())) {
        throw new Error(`${v.name}: wrong destination`);
    }
    const amount = expectProgram.equals(SYSTEM_PROGRAM) ? u64le(lay.data.subarray(4, 12)) : u64le(lay.data.subarray(1, 9));
    if (amount !== expectAmount) {
        throw new Error(`${v.name}: wrong amount`);
    }
}

export function buildParserVectors() {
    const vectors = [];
    const ok = (name, bytes, kind, amount, destination) => {
        const v = {
            name,
            message_hex: hex(bytes),
            device_pubkey: hex(DEVICE.toBuffer()),
            device_usdc_ata: hex(DEVICE_ATA.toBuffer()),
            expect: { status: 'OK', reason: 'OK', kind, amount: amount.toString(), destination: hex(destination.toBuffer()) },
        };
        selfCheckOk(v, kind === 'sol' ? SYSTEM_PROGRAM : TOKEN_PROGRAM, destination, amount);
        vectors.push(v);
    };
    // reason: the tk_parse_result_t the parser must return (without the TK_PARSE_ prefix).
    const bad = (name, reason, bytes) => {
        if (!PARSE_REASONS.includes(reason) || reason === 'OK') {
            throw new Error(`${name}: unknown reason ${reason}`);
        }
        vectors.push({
            name,
            message_hex: hex(bytes),
            device_pubkey: hex(DEVICE.toBuffer()),
            device_usdc_ata: hex(DEVICE_ATA.toBuffer()),
            expect: { status: 'PARSE_UNSUPPORTED', reason, kind: null, amount: null, destination: null },
        });
    };

    // -- Valid --
    const solOk = legacy([solTransfer(1_500_000n)]);
    ok('sol_ok', solOk, 'sol', 1_500_000n, ALICE);
    ok('sol_ok_zero_lamports', legacy([solTransfer(0n)]), 'sol', 0n, ALICE);
    ok('sol_ok_u64_max', legacy([solTransfer(U64_MAX)]), 'sol', U64_MAX, ALICE);
    const usdcOk = legacy([usdcTransfer(2_500_000n)]);
    ok('usdc_ok', usdcOk, 'usdc', 2_500_000n, ALICE_ATA);
    ok('usdc_ok_amount_one', legacy([usdcTransfer(1n)]), 'usdc', 1n, ALICE_ATA);
    ok('usdc_ok_zero', legacy([usdcTransfer(0n)]), 'usdc', 0n, ALICE_ATA);

    const solLay = walkLegacy(solOk);
    const usdcLay = walkLegacy(usdcOk);

    // -- Message format --
    bad('msg_v0', 'VERSIONED', Buffer.from(MessageV0.compile({ payerKey: DEVICE, instructions: [solTransfer(1n)], recentBlockhash: BLOCKHASH }).serialize()));
    for (const [label, base, lay] of [['sol', solOk, solLay], ['usdc', usdcOk, usdcLay]]) {
        const cuts = new Set(lay.fields.map((f) => f.start));
        cuts.add(base.length - 1);
        for (const cut of [...cuts].sort((a, b) => a - b)) {
            bad(`msg_truncated_${label}_at_${String(cut).padStart(3, '0')}`, 'TRUNCATED', base.subarray(0, cut));
        }
        bad(`msg_trailing_byte_${label}`, 'TRAILING_BYTES', Buffer.concat([base, Buffer.from([0x00])]));
    }
    const nKeys = fieldOf(solLay, 'num_account_keys');
    bad('msg_noncanonical_compact_u16_keys', 'BAD_COMPACT_U16', splice(solOk, nKeys.start, nKeys.end, [solOk[nKeys.start] | 0x80, 0x00]));
    const dLen = fieldOf(solLay, 'data_len');
    bad('msg_noncanonical_compact_u16_data_len', 'BAD_COMPACT_U16', splice(solOk, dLen.start, dLen.end, [solOk[dLen.start] | 0x80, 0x00]));
    bad('msg_compact_u16_over_ffff', 'BAD_COMPACT_U16', splice(solOk, nKeys.start, nKeys.end, [0xff, 0xff, 0x04]));
    bad('msg_compact_u16_four_bytes', 'BAD_COMPACT_U16', splice(solOk, nKeys.start, nKeys.end, [0x83, 0x80, 0x80, 0x00]));
    // web3.js serializes into a fixed 1232-byte buffer, so grow the data field by hand.
    const dataF = fieldOf(solLay, 'data');
    const bigData = Buffer.concat([solOk.subarray(dataF.start, dataF.end), Buffer.alloc(MAX_MESSAGE_LEN)]);
    const big = Buffer.concat([solOk.subarray(0, dLen.start), encodeCompactU16(bigData.length), bigData]);
    if (big.length <= MAX_MESSAGE_LEN) {
        throw new Error('oversize vector is not oversize');
    }
    bad('msg_oversized', 'TOO_LARGE', big);
    bad('msg_empty_after_header', 'TRUNCATED', solOk.subarray(0, 3));

    // -- Common checks --
    bad('common_two_instructions', 'INSTRUCTION_COUNT', legacy([solTransfer(1n), solTransfer(2n)]));
    bad('common_wrong_fee_payer', 'FEE_PAYER', legacy([solTransfer(1n, MALLORY, ALICE)], MALLORY));
    bad('common_two_signers', 'BAD_HEADER', legacy([solTransfer(1n, BOB, ALICE)]));
    bad('common_zero_signers', 'BAD_HEADER', patch(solOk, 0, [0x00]));
    bad('common_readonly_signed_nonzero', 'BAD_HEADER', patch(solOk, 1, [0x01]));
    bad('common_readonly_unsigned_all', 'BAD_HEADER', patch(solOk, 2, [solLay.keys.length]));
    const key1 = fieldOf(solLay, 'account_keys[1]');
    const systemIdx = solLay.keys.findIndex((k) => k.equals(SYSTEM_PROGRAM.toBuffer()));
    const recipientIdx = solLay.keys.findIndex((k) => k.equals(ALICE.toBuffer()));
    if (systemIdx < 0 || recipientIdx < 0 || recipientIdx === 0) {
        throw new Error('unexpected SOL key layout');
    }
    const recipientKey = fieldOf(solLay, `account_keys[${recipientIdx}]`);
    bad('common_duplicate_device_key', 'DUPLICATE_KEY', patch(solOk, recipientKey.start, DEVICE.toBuffer()));
    const notSystem = systemIdx === 1 ? fieldOf(solLay, 'account_keys[2]') : key1;
    bad('common_duplicate_program_key', 'DUPLICATE_KEY', patch(solOk, notSystem.start, SYSTEM_PROGRAM.toBuffer()));
    const prog = fieldOf(solLay, 'program_id_index');
    bad('common_program_id_index_out_of_range', 'INDEX_OUT_OF_RANGE', patch(solOk, prog.start, [solLay.keys.length]));
    bad('common_program_id_index_255', 'INDEX_OUT_OF_RANGE', patch(solOk, prog.start, [0xff]));
    const acc1 = fieldOf(solLay, 'account_index[1]');
    bad('common_account_index_out_of_range', 'INDEX_OUT_OF_RANGE', patch(solOk, acc1.start, [solLay.keys.length]));
    bad('common_account_index_255', 'INDEX_OUT_OF_RANGE', patch(solOk, acc1.start, [0xff]));

    // -- Shape A: SOL --
    const t = solTransfer(1n);
    bad('sol_from_not_device', 'SOL_FROM_NOT_DEVICE', legacy([rebuild(t, { keys: [{ pubkey: BOB, isSigner: false, isWritable: true }, t.keys[1]] })]));
    bad('sol_from_is_recipient_index', 'SOL_FROM_NOT_DEVICE', patch(solOk, fieldOf(solLay, 'account_index[0]').start, [solLay.accounts[1]]));
    const disc = fieldOf(solLay, 'data').start;
    bad('sol_instruction_create_account', 'SOL_LAYOUT', patch(solOk, disc, [0x00]));
    bad('sol_instruction_assign', 'SOL_LAYOUT', patch(solOk, disc, [0x01]));
    bad('sol_instruction_transfer_with_seed', 'SOL_LAYOUT', patch(solOk, disc, [0x0b]));
    bad('sol_instruction_assign_real', 'SOL_LAYOUT', legacy([SystemProgram.assign({ accountPubkey: DEVICE, programId: TOKEN_PROGRAM })]));
    bad('sol_data_len_11', 'SOL_LAYOUT', legacy([rebuild(t, { data: t.data.subarray(0, 11) })]));
    bad('sol_data_len_13', 'SOL_LAYOUT', legacy([rebuild(t, { data: Buffer.concat([t.data, Buffer.from([0])]) })]));
    bad('sol_three_accounts', 'SOL_LAYOUT', legacy([rebuild(t, { keys: [...t.keys, { pubkey: CAROL, isSigner: false, isWritable: false }] })]));
    bad('sol_one_account', 'SOL_LAYOUT', legacy([rebuild(t, { keys: [t.keys[0]] })]));

    // -- Shape B: USDC --
    const u = usdcTransfer(1n);
    bad('usdc_plain_transfer', 'TOKEN_LAYOUT', legacy([createTransferInstruction(DEVICE_ATA, ALICE_ATA, DEVICE, 1n, [], TOKEN_PROGRAM)]));
    bad('usdc_plain_transfer_padded', 'TOKEN_LAYOUT', patch(usdcOk, fieldOf(usdcLay, 'data').start, [0x03]));
    bad('usdc_wrong_mint', 'TOKEN_WRONG_MINT', legacy([usdcTransfer(1n, { mint: FAKE_MINT })]));
    bad('usdc_decimals_9', 'TOKEN_WRONG_DECIMALS', legacy([usdcTransfer(1n, { decimals: 9 })]));
    bad('usdc_decimals_0', 'TOKEN_WRONG_DECIMALS', legacy([usdcTransfer(1n, { decimals: 0 })]));
    bad('usdc_source_not_device_ata', 'TOKEN_WRONG_SOURCE', legacy([usdcTransfer(1n, { source: MALLORY_ATA })]));
    bad('usdc_source_is_owner_wallet', 'TOKEN_WRONG_SOURCE', legacy([usdcTransfer(1n, { source: DEVICE })]));
    bad('usdc_owner_not_device', 'TOKEN_OWNER_NOT_DEVICE', legacy([rebuild(u, { keys: [u.keys[0], u.keys[1], u.keys[2], { pubkey: MALLORY, isSigner: false, isWritable: false }] })]));
    bad('usdc_token_2022_program', 'UNSUPPORTED_PROGRAM', legacy([usdcTransfer(1n, { programId: TOKEN_2022_PROGRAM_ID })]));
    bad('usdc_three_accounts', 'TOKEN_LAYOUT', legacy([rebuild(u, { keys: [u.keys[0], u.keys[1], u.keys[2]] })]));
    bad('usdc_data_len_9', 'TOKEN_LAYOUT', legacy([rebuild(u, { data: u.data.subarray(0, 9) })]));
    bad('usdc_data_len_11', 'TOKEN_LAYOUT', legacy([rebuild(u, { data: Buffer.concat([u.data, Buffer.from([0])]) })]));

    vectors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = new Set(vectors.map((v) => v.name));
    if (names.size !== vectors.length) {
        throw new Error('duplicate vector names');
    }
    return vectors;
}

// A second, never-funded test mint, so a derivation that ignores the mint is caught.
const OTHER_MINT = wallet('other-mint');
const DEEP_BUMP_MAX = 251; // "deep" vectors need at least 5 tries

function ataVector(name, label, mint) {
    const w = wallet(label);
    const ata = getAssociatedTokenAddressSync(mint, w, false, TOKEN_PROGRAM, ATA_PROGRAM);
    const [pda, bump] = PublicKey.findProgramAddressSync([w.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
    if (!pda.equals(ata)) {
        throw new Error(`ATA mismatch for ${name}`);
    }
    return { name, wallet: hex(w.toBuffer()), mint: hex(mint.toBuffer()), ata: hex(ata.toBuffer()), bump };
}

export function buildAtaVectors() {
    const vectors = ['device', 'alice', 'bob', 'carol', 'dave', 'mallory'].map((l) => ataVector(l, l, USDC_MINT));
    vectors.push(ataVector('device_other_mint', 'device', OTHER_MINT));
    vectors.push(ataVector('alice_other_mint', 'alice', OTHER_MINT));
    // Labels deep-0, deep-1, ... in order; keep the first two that need a long bump search.
    let found = 0;
    for (let i = 0; found < 2; i++) {
        const v = ataVector(`deep_${i}`, `deep-${i}`, USDC_MINT);
        if (v.bump <= DEEP_BUMP_MAX) {
            vectors.push(v);
            found++;
        }
    }
    return vectors;
}

// Checksum phrases (docs/AUDIO.md), computed with node:crypto: a third implementation, separate
// from core/src/tk_checksum.c and app/src/checksum.ts.
export const TX_TAG = 'TK-TX-v1';
export const ADDR_TAG = 'TK-ADDR-v1';

function phrase(tag, bytes, n) {
    const words = loadWords();
    const h = createHash('sha256').update(Buffer.from(tag, 'ascii')).update(bytes).digest();
    const indices = [...h.subarray(0, n)];
    return { indices, words: indices.map((i) => words[i]) };
}

export function buildChecksumVectors(parser = buildParserVectors(), ata = buildAtaVectors()) {
    const tx = [];
    const addTx = (name, bytes) => tx.push({ name, message_hex: hex(bytes), ...phrase(TX_TAG, bytes, 3) });
    for (const v of parser.filter((p) => p.expect.status === 'OK')) {
        addTx(v.name, Buffer.from(v.message_hex, 'hex'));
    }
    addTx('empty', Buffer.alloc(0));
    addTx('one_byte', Buffer.from([0x01]));
    addTx('max_len', Buffer.from(Array.from({ length: MAX_MESSAGE_LEN }, (_, i) => (i * 7 + 3) & 0xff)));
    // Same transfer, amount differs in one bit: the phrases must differ.
    const base = parser.find((p) => p.name === 'sol_ok');
    const flipped = Buffer.from(base.message_hex, 'hex');
    flipped[flipped.length - 8] ^= 0x01; // lowest bit of the u64 amount
    addTx('sol_ok_amount_bit_flipped', flipped);

    const addr = ata
        .filter((a) => !a.name.includes('other_mint'))
        .map((a) => ({ name: a.name, wallet: a.wallet, ...phrase(ADDR_TAG, Buffer.from(a.wallet, 'hex'), 8) }));
    return { tx, addr };
}

// Contact book lookups (decision 5: SOL -> wallets only, USDC -> USDC ATAs only). The book is
// alice, bob, carol; usdc_ata comes from spl-token so core/contacts' derivation is checked too.
export function buildContactsVectors() {
    const book = [
        ['Alice', ALICE],
        ['Bob', BOB],
        ['Carol', CAROL],
    ].map(([name, w]) => ({ name, wallet: hex(w.toBuffer()), usdc_ata: hex(usdcAta(w).toBuffer()) }));
    const lookups = [];
    const add = (name, kind, dest, expect_index) => lookups.push({ name, kind, destination: hex(dest), expect_index });
    book.forEach((c, i) => {
        add(`${c.name.toLowerCase()}_wallet_sol`, 'sol', Buffer.from(c.wallet, 'hex'), i);
        add(`${c.name.toLowerCase()}_ata_usdc`, 'usdc', Buffer.from(c.usdc_ata, 'hex'), i);
    });
    // Malicious or unknown: all must be "unknown recipient" (-1).
    add('alice_ata_as_sol', 'sol', ALICE_ATA.toBuffer(), -1);
    add('alice_wallet_as_usdc', 'usdc', ALICE.toBuffer(), -1);
    add('mallory_wallet_sol', 'sol', MALLORY.toBuffer(), -1);
    add('mallory_ata_usdc', 'usdc', MALLORY_ATA.toBuffer(), -1);
    const flipped = Buffer.from(ALICE_ATA.toBuffer());
    flipped[31] ^= 0x01;
    add('alice_ata_one_bit_flipped', 'usdc', flipped, -1);
    const otherMintAta = getAssociatedTokenAddressSync(OTHER_MINT, ALICE, false, TOKEN_PROGRAM, ATA_PROGRAM);
    add('alice_other_mint_ata_usdc', 'usdc', otherMintAta.toBuffer(), -1);
    add('device_wallet_sol', 'sol', DEVICE.toBuffer(), -1);
    return { book, lookups };
}

// sha256("taktile-curve:<i>") with web3.js's answer to "is this an ed25519 point?".
export function buildCurveVectors() {
    const vectors = [];
    for (let i = 0; i < 32; i++) {
        const bytes = createHash('sha256').update(`taktile-curve:${i}`).digest();
        vectors.push({ name: `curve_${i}`, bytes: hex(bytes), on_curve: PublicKey.isOnCurve(bytes) });
    }
    return vectors;
}

// ---- Seed: BIP39 + SLIP-10 Ed25519 (core/src/tk_seed.c) ----
//
// Published vectors are copied in as constants and every one is re-derived here with node:crypto
// (an implementation independent of trezor-crypto), so a wrong constant or a wrong JS fails the run.

// SLIP-0010 "Test vector 1/2 for ed25519" (github.com/satoshilabs/slips, slip-0010.md, 2026-11-17).
// private = the Ed25519 key; public = 0x00 || Ed25519 public key.
const H = 0x80000000;
export const SLIP10_PUBLISHED = [
    {
        seed: '000102030405060708090a0b0c0d0e0f',
        chains: [
            { path: [], private: '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7', public: '00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed' },
            { path: [0], private: '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3', public: '008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c' },
            { path: [0, 1], private: 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2', public: '001932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187' },
            { path: [0, 1, 2], private: '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9', public: '00ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1' },
            { path: [0, 1, 2, 2], private: '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662', public: '008abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c' },
            { path: [0, 1, 2, 2, 1000000000], private: '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793', public: '003c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a' },
        ],
    },
    {
        seed: 'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
        chains: [
            { path: [], private: '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012', public: '008fe9693f8fa62a4305a140b9764c5ee01e455963744fe18204b4fb948249308a' },
            { path: [0], private: '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635', public: '0086fab68dcb57aa196c77c5f264f215a112c22a912c10d123b0d03c3c28ef1037' },
            { path: [0, 2147483647], private: 'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4', public: '005ba3b9ac6e90e83effcd25ac4e58a1365a9e35a3d3ae5eb07b9e4d90bcf7506d' },
            { path: [0, 2147483647, 1], private: '3757c7577170179c7868353ada796c839135b3d30554bbb74a4b1e4a5a58505c', public: '002e66aa57069c86cc18249aecf5cb5a9cebbfd6fadeab056254763874a9352b45' },
            { path: [0, 2147483647, 1, 2147483646], private: '5837736c89570de861ebc173b1086da4f505d4adb387c6a1b1342d5e4ac9ec72', public: '00e33c0f7d81d843c572275f287498e8d408654fdf0d1e065b84e2e6f157aab09b' },
            { path: [0, 2147483647, 1, 2147483646, 2], private: '551d333177df541ad876a60ea71f00447931c0a9da16f227c11ea080d7391b8d', public: '0047150c75db263559a70d5778bf36abbab30fb061ad69f69ece61a72b0cfa4fc0' },
        ],
    },
];

// BIP39: the 24-word (256-bit) English vectors of trezor/python-mnemonic vectors.json, passphrase
// "TREZOR" (2026-11-17).
export const BIP39_PASSPHRASE = 'TREZOR';
export const BIP39_PUBLISHED = [
    ['0000000000000000000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art', 'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8'],
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title', 'bc09fca1804f7e69da93c2f2028eb238c227f2e9dda30cd63699232578480a4021b146ad717fbb7e451ce9eb835f43620bf5c514db0f8add49f5d121449d3e87'],
    ['8080808080808080808080808080808080808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless', 'c0c519bd0e91a2ed54357d9d1ebef6f5af218a153624cf4f2da911a0ed8f7a09e2ef61af0aca007096df430022f7a2b6fb91661a9589097069720d015e4e982f'],
    ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote', 'dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb00089b32d22484e1613912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad'],
    ['68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c', 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length', '64c87cde7e12ecf6704ab95bb1408bef047c22db4cc7491c4271d170a1b213d20b385bc1588d9c7b38f1b39d415665b8a9030c9ec653d75e65f847d8fc1fc440'],
    ['9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863', 'panda eyebrow bullet gorilla call smoke muffin taste mesh discover soft ostrich alcohol speed nation flash devote level hobby quick inner drive ghost inside', '72be8e052fc4919d2adf28d5306b5474b0069df35b02303de8c1729c9538dbb6fc2d731d5f832193cd9fb6aeecbc469594a70e3dd50811b5067f3b88b28c3e8d'],
    ['066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad', 'all hour make first leader extend hole alien behind guard gospel lava path output census museum junior mass reopen famous sing advance salt reform', '26e975ec644423f4a4c4f4215ef09b4bd7ef924e85d1d17c4cf3f136c2863cf6df0a475045652c57eb5fb41513ca2a2d67722b77e954b4b3fc11f7590449191d'],
    ['f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f', 'void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold', '01f5bced59dec48e362f2c45b5de68b9fd6c92c6634f44d6d40aab69056506f0e35524a518034ddc1192e1dacd32c1ed3eaa3c3b131c88ed8e7e54c49a5d0998'],
];

export const SOLANA_PATH = [44 + H, 501 + H, 0 + H, 0 + H];

// The English list, read from the vendored C table (the list itself is the BIP39 standard; the
// published vectors above check that it was read correctly).
export function loadBip39Words() {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(root, 'core/third_party/trezor-crypto/bip39_english.c'), 'utf8');
    const body = src.slice(src.indexOf('{'), src.lastIndexOf('}'));
    const words = [...body.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    if (words.length !== 2048) throw new Error(`bip39_english.c: ${words.length} words, want 2048`);
    return words;
}

export function bip39Indices(entropy) {
    if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
    const check = createHash('sha256').update(entropy).digest()[0];
    let bits = 0n;
    for (const b of [...entropy, check]) bits = (bits << 8n) | BigInt(b);
    const idx = [];
    for (let w = 23; w >= 0; w--) idx.push(Number((bits >> BigInt(w * 11)) & 0x7ffn)); // first word = top bits
    return idx;
}

export const bip39Seed = (mnemonic, passphrase) =>
    pbkdf2Sync(Buffer.from(mnemonic.normalize('NFKD'), 'utf8'), Buffer.from('mnemonic' + passphrase, 'utf8'), 2048, 64, 'sha512');

export function slip10Ed25519(seed, path) {
    let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
    for (const index of path) {
        if (index < H) throw new Error('SLIP-10 Ed25519: hardened indices only');
        const data = Buffer.alloc(37);
        I.copy(data, 1, 0, 32);
        data.writeUInt32BE(index >>> 0, 33);
        I = createHmac('sha512', I.subarray(32)).update(data).digest();
    }
    return I.subarray(0, 32);
}

export function buildSeedVectors() {
    const words = loadBip39Words();
    const slip10 = [];
    SLIP10_PUBLISHED.forEach((s, si) => {
        for (const c of s.chains) {
            const path = c.path.map((i) => (i + H) >>> 0);
            const key = slip10Ed25519(Buffer.from(s.seed, 'hex'), path);
            if (hex(key) !== c.private) throw new Error(`SLIP-10 vector ${si + 1} m/${c.path.join("'/")}: private mismatch`);
            const pub = Keypair.fromSeed(key).publicKey.toBuffer();
            if ('00' + hex(pub) !== c.public) throw new Error(`SLIP-10 vector ${si + 1}: public mismatch`);
            slip10.push({ name: `slip10_v${si + 1}_depth${c.path.length}`, seed: s.seed, path, key: c.private, pubkey: hex(pub) });
        }
    });

    const bip39 = BIP39_PUBLISHED.map(([entHex, mnemonic, seedHex], i) => {
        const idx = bip39Indices(Buffer.from(entHex, 'hex'));
        if (idx.map((n) => words[n]).join(' ') !== mnemonic) throw new Error(`BIP39 vector ${i}: mnemonic mismatch`);
        if (hex(bip39Seed(mnemonic, BIP39_PASSPHRASE)) !== seedHex) throw new Error(`BIP39 vector ${i}: seed mismatch`);
        return { name: `bip39_${i}`, entropy: entHex, indices: idx, mnemonic, passphrase: BIP39_PASSPHRASE, seed: seedHex };
    });

    // What SETUP does: no passphrase, Solana path, then the Ed25519 public key (web3.js).
    const solana = BIP39_PUBLISHED.map(([entHex, mnemonic], i) => {
        const seed = bip39Seed(mnemonic, '');
        const key = slip10Ed25519(seed, SOLANA_PATH);
        const kp = Keypair.fromSeed(key);
        return { name: `solana_${i}`, mnemonic, seed: hex(seed), key: hex(key), pubkey: hex(kp.publicKey.toBuffer()), address: kp.publicKey.toBase58() };
    });
    return { slip10, bip39, solana };
}

// ---- Rendering ----

const BANNER = '// GENERATED by tools/gen-vectors.mjs. Do not edit; rerun the script.\n';

function cBytes(bytes, indent = '    ') {
    const h = [...bytes].map((b) => '0x' + b.toString(16).padStart(2, '0'));
    const lines = [];
    for (let i = 0; i < h.length; i += 12) {
        lines.push(indent + h.slice(i, i + 12).join(', ') + ',');
    }
    return lines.join('\n');
}

const cIdent = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');

function renderParserHeader(vectors) {
    const out = [
        BANNER,
        '#ifndef TK_PARSER_VECTORS_H',
        '#define TK_PARSER_VECTORS_H',
        '',
        '#include <stdbool.h>',
        '#include <stddef.h>',
        '#include <stdint.h>',
        '',
        '#include "tk_parser.h"',
        '#include "tk_proto.h"',
        '',
        'typedef enum { TK_VEC_KIND_NONE = 0, TK_VEC_KIND_SOL, TK_VEC_KIND_USDC } tk_vec_kind_t;',
        '',
        'typedef struct {',
        '    const char *name;',
        '    const uint8_t *msg; // msg_len bytes',
        '    size_t msg_len;',
        '    uint8_t device_pubkey[32];',
        '    uint8_t device_usdc_ata[32];',
        '    tk_status_t status;',
        '    tk_parse_result_t reason;',
        '    tk_vec_kind_t kind;',
        '    uint64_t amount;         // valid when status == TK_STATUS_OK',
        '    uint8_t destination[32]; // valid when status == TK_STATUS_OK',
        '} tk_parser_vector_t;',
        '',
    ];
    for (const v of vectors) {
        const bytes = Buffer.from(v.message_hex, 'hex');
        out.push(`static const uint8_t tk_vec_msg_${cIdent(v.name)}[] = {`);
        out.push(bytes.length ? cBytes(bytes) : '    0x00, // placeholder: msg_len is 0');
        out.push('};');
    }
    out.push('', 'static const tk_parser_vector_t tk_parser_vectors[] = {');
    for (const v of vectors) {
        const bytes = Buffer.from(v.message_hex, 'hex');
        const e = v.expect;
        const kind = e.kind === 'sol' ? 'TK_VEC_KIND_SOL' : e.kind === 'usdc' ? 'TK_VEC_KIND_USDC' : 'TK_VEC_KIND_NONE';
        const dest = e.destination ? Buffer.from(e.destination, 'hex') : Buffer.alloc(32);
        out.push('    {');
        out.push(`        "${v.name}", tk_vec_msg_${cIdent(v.name)}, ${bytes.length},`);
        out.push('        {');
        out.push(cBytes(Buffer.from(v.device_pubkey, 'hex'), '            '));
        out.push('        },');
        out.push('        {');
        out.push(cBytes(Buffer.from(v.device_usdc_ata, 'hex'), '            '));
        out.push('        },');
        out.push(`        TK_STATUS_${e.status}, TK_PARSE_${e.reason}, ${kind}, UINT64_C(${e.amount ?? 0}),`);
        out.push('        {');
        out.push(cBytes(dest, '            '));
        out.push('        },');
        out.push('    },');
    }
    out.push('};', '', '#define TK_PARSER_VECTOR_COUNT (sizeof(tk_parser_vectors) / sizeof(tk_parser_vectors[0]))', '', '#endif', '');
    return out.join('\n');
}

function renderAtaHeader(vectors) {
    const out = [
        BANNER,
        '#ifndef TK_ATA_VECTORS_H',
        '#define TK_ATA_VECTORS_H',
        '',
        '#include <stdint.h>',
        '',
        'typedef struct {',
        '    const char *name;',
        '    uint8_t wallet[32];',
        '    uint8_t mint[32];',
        '    uint8_t ata[32]; // getAssociatedTokenAddressSync(mint, wallet)',
        '    uint8_t bump;',
        '} tk_ata_vector_t;',
        '',
        'static const tk_ata_vector_t tk_ata_vectors[] = {',
    ];
    for (const v of vectors) {
        out.push('    {', `        "${v.name}",`);
        for (const k of ['wallet', 'mint', 'ata']) {
            out.push('        {', cBytes(Buffer.from(v[k], 'hex'), '            '), '        },');
        }
        out.push(`        ${v.bump},`, '    },');
    }
    out.push('};', '', '#define TK_ATA_VECTOR_COUNT (sizeof(tk_ata_vectors) / sizeof(tk_ata_vectors[0]))', '', '#endif', '');
    return out.join('\n');
}

function renderCurveHeader(vectors) {
    const out = [
        BANNER,
        '#ifndef TK_CURVE_VECTORS_H',
        '#define TK_CURVE_VECTORS_H',
        '',
        '#include <stdbool.h>',
        '#include <stdint.h>',
        '',
        'typedef struct {',
        '    const char *name;',
        '    uint8_t bytes[32];',
        '    bool on_curve; // web3.js PublicKey.isOnCurve',
        '} tk_curve_vector_t;',
        '',
        'static const tk_curve_vector_t tk_curve_vectors[] = {',
    ];
    for (const v of vectors) {
        out.push('    {', `        "${v.name}",`, '        {', cBytes(Buffer.from(v.bytes, 'hex'), '            '), '        },');
        out.push(`        ${v.on_curve},`, '    },');
    }
    out.push('};', '', '#define TK_CURVE_VECTOR_COUNT (sizeof(tk_curve_vectors) / sizeof(tk_curve_vectors[0]))', '', '#endif', '');
    return out.join('\n');
}

function renderChecksumHeader({ tx, addr }) {
    const words = (ws) => ws.map((w) => `"${w}"`).join(', ');
    const out = [
        BANNER,
        '#ifndef TK_CHECKSUM_VECTORS_H',
        '#define TK_CHECKSUM_VECTORS_H',
        '',
        '#include <stddef.h>',
        '#include <stdint.h>',
        '',
        'typedef struct {',
        '    const char *name;',
        '    const uint8_t *msg; // msg_len bytes',
        '    size_t msg_len;',
        '    uint8_t indices[3];',
        '    const char *words[3];',
        '} tk_checksum_tx_vector_t;',
        '',
        'typedef struct {',
        '    const char *name;',
        '    uint8_t wallet[32];',
        '    uint8_t indices[8];',
        '    const char *words[8];',
        '} tk_checksum_addr_vector_t;',
        '',
    ];
    for (const v of tx) {
        const bytes = Buffer.from(v.message_hex, 'hex');
        out.push(`static const uint8_t tk_ck_msg_${cIdent(v.name)}[] = {`);
        out.push(bytes.length ? cBytes(bytes) : '    0x00, // placeholder: msg_len is 0');
        out.push('};');
    }
    out.push('', 'static const tk_checksum_tx_vector_t tk_checksum_tx_vectors[] = {');
    for (const v of tx) {
        out.push('    {', `        "${v.name}", tk_ck_msg_${cIdent(v.name)}, ${v.message_hex.length / 2},`);
        out.push(`        {${v.indices.join(', ')}},`, `        {${words(v.words)}},`, '    },');
    }
    out.push('};', '', 'static const tk_checksum_addr_vector_t tk_checksum_addr_vectors[] = {');
    for (const v of addr) {
        out.push('    {', `        "${v.name}",`, '        {', cBytes(Buffer.from(v.wallet, 'hex'), '            '), '        },');
        out.push(`        {${v.indices.join(', ')}},`, `        {${words(v.words)}},`, '    },');
    }
    out.push(
        '};',
        '',
        '#define TK_CHECKSUM_TX_VECTOR_COUNT (sizeof(tk_checksum_tx_vectors) / sizeof(tk_checksum_tx_vectors[0]))',
        '#define TK_CHECKSUM_ADDR_VECTOR_COUNT (sizeof(tk_checksum_addr_vectors) / sizeof(tk_checksum_addr_vectors[0]))',
        '',
        '#endif',
        '',
    );
    return out.join('\n');
}

function renderContactsHeader({ book, lookups }) {
    const out = [
        BANNER,
        '#ifndef TK_CONTACTS_VECTORS_H',
        '#define TK_CONTACTS_VECTORS_H',
        '',
        '#include <stdint.h>',
        '',
        '#include "tk_parser.h"',
        '',
        'typedef struct {',
        '    const char *name;',
        '    uint8_t wallet[32];',
        '    uint8_t usdc_ata[32]; // getAssociatedTokenAddressSync(USDC, wallet)',
        '} tk_contacts_book_entry_t;',
        '',
        'typedef struct {',
        '    const char *name;',
        '    tk_tx_kind_t kind;',
        '    uint8_t destination[32];',
        '    int expect_index; // -1: unknown recipient',
        '} tk_contacts_lookup_vector_t;',
        '',
        'static const tk_contacts_book_entry_t tk_contacts_book[] = {',
    ];
    for (const c of book) {
        out.push('    {', `        "${c.name}",`);
        for (const k of ['wallet', 'usdc_ata']) {
            out.push('        {', cBytes(Buffer.from(c[k], 'hex'), '            '), '        },');
        }
        out.push('    },');
    }
    out.push('};', '', 'static const tk_contacts_lookup_vector_t tk_contacts_lookups[] = {');
    for (const l of lookups) {
        const kind = l.kind === 'sol' ? 'TK_TX_SOL' : 'TK_TX_USDC';
        out.push('    {', `        "${l.name}", ${kind},`, '        {', cBytes(Buffer.from(l.destination, 'hex'), '            '), '        },');
        out.push(`        ${l.expect_index},`, '    },');
    }
    out.push(
        '};',
        '',
        '#define TK_CONTACTS_BOOK_COUNT (sizeof(tk_contacts_book) / sizeof(tk_contacts_book[0]))',
        '#define TK_CONTACTS_LOOKUP_COUNT (sizeof(tk_contacts_lookups) / sizeof(tk_contacts_lookups[0]))',
        '',
        '#endif',
        '',
    );
    return out.join('\n');
}

function renderSeedHeader({ slip10, bip39, solana }) {
    const b = (h, ind) => cBytes(Buffer.from(h, 'hex'), ind);
    const out = [
        BANNER,
        '// Published SLIP-0010 and BIP39 vectors (re-derived with node:crypto) and Solana-path vectors.',
        '// Public test data only: never fund these keys.',
        '',
        '#ifndef TK_SEED_VECTORS_H',
        '#define TK_SEED_VECTORS_H',
        '',
        '#include <stddef.h>',
        '#include <stdint.h>',
        '',
        'typedef struct {',
        '    const char *name;',
        '    const char *seed_hex; // variable length',
        '    uint32_t path[5];',
        '    size_t path_len;',
        '    uint8_t key[32];',
        '    uint8_t pubkey[32];',
        '} tk_slip10_vector_t;',
        '',
        'typedef struct {',
        '    const char *name;',
        '    uint8_t entropy[32];',
        '    uint16_t indices[24];',
        '    const char *mnemonic;',
        '    const char *passphrase;',
        '    uint8_t seed[64];',
        '} tk_bip39_vector_t;',
        '',
        'typedef struct {',
        '    const char *name;',
        '    const char *mnemonic; // no passphrase, path m/44\'/501\'/0\'/0\'',
        '    uint8_t key[32];',
        '    uint8_t pubkey[32];',
        '    const char *address;',
        '} tk_solana_seed_vector_t;',
        '',
        'static const tk_slip10_vector_t tk_slip10_vectors[] = {',
    ];
    for (const v of slip10) {
        const path = v.path.map((i) => '0x' + i.toString(16) + 'u').concat(Array(5 - v.path.length).fill('0')).join(', ');
        out.push('    {', `        "${v.name}",`, `        "${v.seed}",`, `        {${path}},`, `        ${v.path.length},`);
        out.push('        {', b(v.key, '            '), '        },', '        {', b(v.pubkey, '            '), '        },', '    },');
    }
    out.push('};', '', 'static const tk_bip39_vector_t tk_bip39_vectors[] = {');
    for (const v of bip39) {
        out.push('    {', `        "${v.name}",`, '        {', b(v.entropy, '            '), '        },');
        out.push(`        {${v.indices.join(', ')}},`, `        "${v.mnemonic}",`, `        "${v.passphrase}",`);
        out.push('        {', b(v.seed, '            '), '        },', '    },');
    }
    out.push('};', '', 'static const tk_solana_seed_vector_t tk_solana_seed_vectors[] = {');
    for (const v of solana) {
        out.push('    {', `        "${v.name}",`, `        "${v.mnemonic}",`, '        {', b(v.key, '            '), '        },');
        out.push('        {', b(v.pubkey, '            '), '        },', `        "${v.address}",`, '    },');
    }
    out.push(
        '};',
        '',
        '#define TK_SLIP10_VECTOR_COUNT (sizeof(tk_slip10_vectors) / sizeof(tk_slip10_vectors[0]))',
        '#define TK_BIP39_VECTOR_COUNT (sizeof(tk_bip39_vectors) / sizeof(tk_bip39_vectors[0]))',
        '#define TK_SOLANA_SEED_VECTOR_COUNT (sizeof(tk_solana_seed_vectors) / sizeof(tk_solana_seed_vectors[0]))',
        '',
        '#endif',
        '',
    );
    return out.join('\n');
}

// Returns [[relativePath, contents], ...]. Deterministic, LF only.
export function generate() {
    const parser = buildParserVectors();
    const ata = buildAtaVectors();
    const curve = buildCurveVectors();
    const checksum = buildChecksumVectors(parser, ata);
    const contacts = buildContactsVectors();
    const seed = buildSeedVectors();
    return [
        ['tests/vectors/contacts.json', JSON.stringify(contacts, null, 2) + '\n'],
        ['core/tests/gen/tk_contacts_vectors.h', renderContactsHeader(contacts)],
        ['tests/vectors/parser.json', JSON.stringify(parser, null, 2) + '\n'],
        ['tests/vectors/ata.json', JSON.stringify(ata, null, 2) + '\n'],
        ['tests/vectors/curve.json', JSON.stringify(curve, null, 2) + '\n'],
        ['tests/vectors/checksum.json', JSON.stringify(checksum, null, 2) + '\n'],
        ['core/tests/gen/tk_parser_vectors.h', renderParserHeader(parser)],
        ['core/tests/gen/tk_ata_vectors.h', renderAtaHeader(ata)],
        ['core/tests/gen/tk_curve_vectors.h', renderCurveHeader(curve)],
        ['core/tests/gen/tk_checksum_vectors.h', renderChecksumHeader(checksum)],
        ['tests/vectors/seed.json', JSON.stringify(seed, null, 2) + '\n'],
        ['core/tests/gen/tk_seed_vectors.h', renderSeedHeader(seed)],
    ];
}

function main(argv) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = generate();
    if (!argv.includes('--check')) {
        for (const [rel, text] of files) {
            const path = join(root, rel);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, text);
            console.log(`wrote ${rel}`);
        }
        return 0;
    }
    let ok = true;
    for (const [rel, text] of files) {
        let current = null;
        try {
            current = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
        } catch {
            // missing: reported below
        }
        if (current !== text) {
            console.error(`stale: ${rel} (run node tools/gen-vectors.mjs)`);
            ok = false;
        }
    }
    if (ok) {
        console.log('vectors: up to date');
    }
    return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv.slice(2));
}
