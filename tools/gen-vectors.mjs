#!/usr/bin/env node
// Build Solana legacy messages with web3.js / spl-token and write the parser and ATA test vectors.
//
//   node tools/gen-vectors.mjs           write tests/vectors/{parser,ata}.json and core/tests/gen/*.h
//   node tools/gen-vectors.mjs --check   write nothing; exit 1 if any committed file is stale
//
// Needs `cd tools && npm ci` once. Never touches the network: it only builds messages.
// Wallets come from public labels ("taktile-vector:<label>"); only public keys are written.

import { createHash } from 'node:crypto';
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

const MAX_MESSAGE_LEN = 1232; // docs/SOLANA.md
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
            expect: { status: 'OK', kind, amount: amount.toString(), destination: hex(destination.toBuffer()) },
        };
        selfCheckOk(v, kind === 'sol' ? SYSTEM_PROGRAM : TOKEN_PROGRAM, destination, amount);
        vectors.push(v);
    };
    const bad = (name, bytes) => {
        vectors.push({
            name,
            message_hex: hex(bytes),
            device_pubkey: hex(DEVICE.toBuffer()),
            expect: { status: 'PARSE_UNSUPPORTED', kind: null, amount: null, destination: null },
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

    const solLay = walkLegacy(solOk);
    const usdcLay = walkLegacy(usdcOk);

    // -- Message format --
    bad('msg_v0', Buffer.from(MessageV0.compile({ payerKey: DEVICE, instructions: [solTransfer(1n)], recentBlockhash: BLOCKHASH }).serialize()));
    for (const [label, base, lay] of [['sol', solOk, solLay], ['usdc', usdcOk, usdcLay]]) {
        const cuts = new Set(lay.fields.map((f) => f.start));
        cuts.add(base.length - 1);
        for (const cut of [...cuts].sort((a, b) => a - b)) {
            bad(`msg_truncated_${label}_at_${String(cut).padStart(3, '0')}`, base.subarray(0, cut));
        }
        bad(`msg_trailing_byte_${label}`, Buffer.concat([base, Buffer.from([0x00])]));
    }
    const nKeys = fieldOf(solLay, 'num_account_keys');
    bad('msg_noncanonical_compact_u16_keys', splice(solOk, nKeys.start, nKeys.end, [solOk[nKeys.start] | 0x80, 0x00]));
    const dLen = fieldOf(solLay, 'data_len');
    bad('msg_noncanonical_compact_u16_data_len', splice(solOk, dLen.start, dLen.end, [solOk[dLen.start] | 0x80, 0x00]));
    bad('msg_compact_u16_over_ffff', splice(solOk, nKeys.start, nKeys.end, [0xff, 0xff, 0x04]));
    bad('msg_compact_u16_four_bytes', splice(solOk, nKeys.start, nKeys.end, [0x83, 0x80, 0x80, 0x00]));
    // web3.js serializes into a fixed 1232-byte buffer, so grow the data field by hand.
    const dataF = fieldOf(solLay, 'data');
    const bigData = Buffer.concat([solOk.subarray(dataF.start, dataF.end), Buffer.alloc(MAX_MESSAGE_LEN)]);
    const big = Buffer.concat([solOk.subarray(0, dLen.start), encodeCompactU16(bigData.length), bigData]);
    if (big.length <= MAX_MESSAGE_LEN) {
        throw new Error('oversize vector is not oversize');
    }
    bad('msg_oversized', big);
    bad('msg_empty_after_header', solOk.subarray(0, 3));

    // -- Common checks --
    bad('common_two_instructions', legacy([solTransfer(1n), solTransfer(2n)]));
    bad('common_wrong_fee_payer', legacy([solTransfer(1n, MALLORY, ALICE)], MALLORY));
    bad('common_two_signers', legacy([solTransfer(1n, BOB, ALICE)]));
    bad('common_zero_signers', patch(solOk, 0, [0x00]));
    const prog = fieldOf(solLay, 'program_id_index');
    bad('common_program_id_index_out_of_range', patch(solOk, prog.start, [solLay.keys.length]));
    bad('common_program_id_index_255', patch(solOk, prog.start, [0xff]));
    const acc1 = fieldOf(solLay, 'account_index[1]');
    bad('common_account_index_out_of_range', patch(solOk, acc1.start, [solLay.keys.length]));
    bad('common_account_index_255', patch(solOk, acc1.start, [0xff]));

    // -- Shape A: SOL --
    const t = solTransfer(1n);
    bad('sol_from_not_device', legacy([rebuild(t, { keys: [{ pubkey: BOB, isSigner: false, isWritable: true }, t.keys[1]] })]));
    bad('sol_from_is_recipient_index', patch(solOk, fieldOf(solLay, 'account_index[0]').start, [solLay.accounts[1]]));
    const disc = fieldOf(solLay, 'data').start;
    bad('sol_instruction_create_account', patch(solOk, disc, [0x00]));
    bad('sol_instruction_assign', patch(solOk, disc, [0x01]));
    bad('sol_instruction_transfer_with_seed', patch(solOk, disc, [0x0b]));
    bad('sol_instruction_assign_real', legacy([SystemProgram.assign({ accountPubkey: DEVICE, programId: TOKEN_PROGRAM })]));
    bad('sol_data_len_11', legacy([rebuild(t, { data: t.data.subarray(0, 11) })]));
    bad('sol_data_len_13', legacy([rebuild(t, { data: Buffer.concat([t.data, Buffer.from([0])]) })]));
    bad('sol_three_accounts', legacy([rebuild(t, { keys: [...t.keys, { pubkey: CAROL, isSigner: false, isWritable: false }] })]));
    bad('sol_one_account', legacy([rebuild(t, { keys: [t.keys[0]] })]));

    // -- Shape B: USDC --
    const u = usdcTransfer(1n);
    bad('usdc_plain_transfer', legacy([createTransferInstruction(DEVICE_ATA, ALICE_ATA, DEVICE, 1n, [], TOKEN_PROGRAM)]));
    bad('usdc_plain_transfer_padded', patch(usdcOk, fieldOf(usdcLay, 'data').start, [0x03]));
    bad('usdc_wrong_mint', legacy([usdcTransfer(1n, { mint: FAKE_MINT })]));
    bad('usdc_decimals_9', legacy([usdcTransfer(1n, { decimals: 9 })]));
    bad('usdc_decimals_0', legacy([usdcTransfer(1n, { decimals: 0 })]));
    bad('usdc_source_not_device_ata', legacy([usdcTransfer(1n, { source: MALLORY_ATA })]));
    bad('usdc_source_is_owner_wallet', legacy([usdcTransfer(1n, { source: DEVICE })]));
    bad('usdc_owner_not_device', legacy([rebuild(u, { keys: [u.keys[0], u.keys[1], u.keys[2], { pubkey: MALLORY, isSigner: false, isWritable: false }] })]));
    bad('usdc_token_2022_program', legacy([usdcTransfer(1n, { programId: TOKEN_2022_PROGRAM_ID })]));
    bad('usdc_three_accounts', legacy([rebuild(u, { keys: [u.keys[0], u.keys[1], u.keys[2]] })]));
    bad('usdc_data_len_9', legacy([rebuild(u, { data: u.data.subarray(0, 9) })]));
    bad('usdc_data_len_11', legacy([rebuild(u, { data: Buffer.concat([u.data, Buffer.from([0])]) })]));

    vectors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = new Set(vectors.map((v) => v.name));
    if (names.size !== vectors.length) {
        throw new Error('duplicate vector names');
    }
    return vectors;
}

export function buildAtaVectors() {
    return ['device', 'alice', 'bob', 'carol', 'dave', 'mallory'].map((label) => {
        const w = wallet(label);
        const ata = usdcAta(w);
        const [pda, bump] = PublicKey.findProgramAddressSync(
            [w.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()],
            ATA_PROGRAM,
        );
        if (!pda.equals(ata)) {
            throw new Error(`ATA mismatch for ${label}`);
        }
        return { name: label, wallet: hex(w.toBuffer()), mint: hex(USDC_MINT.toBuffer()), ata: hex(ata.toBuffer()), bump };
    });
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
        '#include "tk_proto.h"',
        '',
        'typedef enum { TK_VEC_KIND_NONE = 0, TK_VEC_KIND_SOL, TK_VEC_KIND_USDC } tk_vec_kind_t;',
        '',
        'typedef struct {',
        '    const char *name;',
        '    const uint8_t *msg; // msg_len bytes',
        '    size_t msg_len;',
        '    uint8_t device_pubkey[32];',
        '    tk_status_t status;',
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
        out.push(`        TK_STATUS_${e.status}, ${kind}, ${e.amount ?? 0}u,`);
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

// Returns [[relativePath, contents], ...]. Deterministic, LF only.
export function generate() {
    const parser = buildParserVectors();
    const ata = buildAtaVectors();
    return [
        ['tests/vectors/parser.json', JSON.stringify(parser, null, 2) + '\n'],
        ['tests/vectors/ata.json', JSON.stringify(ata, null, 2) + '\n'],
        ['core/tests/gen/tk_parser_vectors.h', renderParserHeader(parser)],
        ['core/tests/gen/tk_ata_vectors.h', renderAtaHeader(ata)],
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
