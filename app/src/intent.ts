// Deterministic intent parser: "send 5 USDC to Henry" -> {token, amount, contact}, plus the other
// voice commands (docs/EXTRATASKS.md Part 1). No LLM, no network. The input is untrusted text (typed,
// or from speech-to-text); a mistake here can only make the app build the wrong transaction, which the
// device then announces truthfully (I1, I3), or answer the wrong read-only question.
//
// Grammar, after normalizing and dropping a leading "hey Taktile", "can you", "could you", ...:
//   fixed phrases first (help, repeat, cancel, lock, address, contacts, staked, activity, requests,
//   balance), so "what was my last transfer" or "did Max pay me" never reach the send verbs; then
//   (send|pay|transfer|give) <amount> <token>? to <name>
//   (request <amount> <token>? from <name>) | (ask <name> for <amount> <token>?)
//   stake <amount> sol? | unstake (all)?
//   amount: digits ("0.01", ".5", "1,000") or number words ("two point five", "one hundred twenty")
//   token:  sol | usdc; "$5" and "5 dollars" mean USDC; no token at all is refused ("Say SOL or USDC"),
//           except for stake, where only SOL is possible.

import { AmountError, DECIMALS, parseAmount, type Token } from './amount.ts';
import type { AppContact } from './contacts.ts';

export type IntentErrorCode =
    | 'not_a_command'
    | 'no_amount'
    | 'no_token'
    | 'too_many_decimals'
    | 'too_large'
    | 'no_name'
    | 'no_contacts'
    | 'unknown_name'
    | 'did_you_mean'
    | 'ambiguous_name'
    | 'only_sol';

type Amount = { token: Token; amount: bigint; amountText: string };

export type Intent =
    | ({ kind: 'send'; contact: AppContact } & Amount)
    | { kind: 'error'; code: IntentErrorCode; message: string; suggestion?: AppContact }
    /** The name is the first word(s) of two or more contacts ("Jack" -> Jack Miller, Jack Chen). The
     *  app asks which one (src/disambiguate.ts); nothing is sent until the user picks one of these. */
    | ({ kind: 'ambiguous'; spoken: string; candidates: AppContact[] } & Amount)
    // Money (request: Part 2; stake/unstake: Part 3)
    | ({ kind: 'request'; contact: AppContact } & Amount)
    | { kind: 'stake'; amount: bigint; amountText: string }
    | { kind: 'unstake'; all: boolean }
    // Read-only information from the laptop (RPC or app state): never an input to signing
    | { kind: 'balance'; token: Token | null }
    | { kind: 'staked' }
    | { kind: 'activity' }
    | { kind: 'requests'; contact: AppContact | null }
    // Spoken by the device itself
    | { kind: 'address' }
    | { kind: 'contacts' }
    | { kind: 'lock' }
    // App control
    | { kind: 'repeat' }
    | { kind: 'cancel' }
    | { kind: 'help' };

export type IntentKind = Intent['kind'];

const VERBS = new Set(['send', 'pay', 'transfer', 'give']);
const FILLER = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'please', 'okay', 'ok']);
/** Dropped only at the start, repeatedly: "hey Taktile, can you please tell me ..." */
const LEAD = [
    ['hey', 'taktile'],
    ['hey', 'tactile'],
    ['hi', 'taktile'],
    ['taktile'],
    ['tactile'],
    ['hey'],
    ['can', 'you'],
    ['could', 'you'],
    ['would', 'you'],
    ['will', 'you'],
    ['tell', 'me'],
    ['i', 'want', 'to'],
    ['i', 'would', 'like', 'to'],
    ["i'd", 'like', 'to'],
];
const HOWTO = 'Say it like: send 5 USDC to Henry.';
const HELP_HINT = 'Say help for a list of commands.';

const UNITS: Record<string, number> = {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
}; // prettier-ignore
const TENS: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}; // prettier-ignore
const DIGIT_WORDS = new Set(['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const isNumberWord = (w: string): boolean => w in UNITS || w in TENS || w === 'hundred' || w === 'thousand';

const err = (code: IntentErrorCode, message: string, suggestion?: AppContact): Intent =>
    suggestion ? { kind: 'error', code, message, suggestion } : { kind: 'error', code, message };

const DOT = ''; // private-use placeholder, never in real input after this step

/** Lowercase, unify the token spellings speech-to-text produces, drop punctuation and filler words. */
export function normalize(text: string): string[] {
    let s = ` ${text.toLowerCase()} `;
    s = s.replace(/(\d),(?=\d{3}\b)/g, '$1'); // 1,000 -> 1000
    s = s.replace(/\bu\.?\s?s\.?\s?d\.?\s?c\b\.?/g, ' usdc '); // U.S.D.C. / u s d c / usd c
    s = s.replace(/\busdcs\b/g, 'usdc');
    s = s.replace(/\bsols\b/g, 'sol');
    s = s.replace(/(\s)\.(\d)/g, '$10.$2'); // .5 -> 0.5
    s = s.replace(/\$\s?(\d[\d.]*)/g, ' $$$1 '); // keep "$5" as one token
    s = s.replace(/(\d)\.(\d)/g, `$1${DOT}$2`); // protect decimal points from the punctuation strip
    s = s.replace(/[.,!?;:"]/g, ' ');
    s = s.split(DOT).join('.');
    return s.split(/\s+/).filter((w) => w !== '' && !FILLER.has(w));
}

/** Number words starting at i -> [decimal text, words used], or null. */
function numberWords(words: string[], i: number): [string, number] | null {
    let total = 0;
    let current = 0;
    let j = i;
    let any = false;
    while (j < words.length) {
        const w = words[j] ?? '';
        if (w in UNITS) {
            current += UNITS[w] ?? 0;
        } else if (w in TENS) {
            current += TENS[w] ?? 0;
        } else if (w === 'hundred') {
            current = (current || 1) * 100;
        } else if (w === 'thousand') {
            total += (current || 1) * 1000;
            current = 0;
        } else if (w === 'and' && any && isNumberWord(words[j + 1] ?? '')) {
            // "one hundred and five"
        } else if (w === 'a' && !any && (words[j + 1] === 'hundred' || words[j + 1] === 'thousand')) {
            // "a hundred"
        } else {
            break;
        }
        any = any || w !== 'a';
        j++;
    }
    if (!any) {
        return null;
    }
    let text = String(total + current);
    if (words[j] === 'point' && DIGIT_WORDS.has(words[j + 1] ?? '')) {
        j++;
        let frac = '';
        while (DIGIT_WORDS.has(words[j] ?? '')) {
            frac += String(UNITS[words[j] ?? ''] ?? 0);
            j++;
        }
        text += `.${frac}`;
    }
    return [text, j - i];
}

function editDistance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) {
        (d[0] as number[])[j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const row = d[i] as number[];
            const prev = d[i - 1] as number[];
            row[j] = Math.min(
                (prev[j] ?? 0) + 1,
                (row[j - 1] ?? 0) + 1,
                (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return (d[a.length] as number[])[b.length] ?? 0;
}

function stripLead(words: string[]): string[] {
    let w = words;
    for (let changed = true; changed; ) {
        changed = false;
        for (const lead of LEAD) {
            if (lead.length < w.length && lead.every((x, k) => w[k] === x)) {
                w = w.slice(lead.length);
                changed = true;
            }
        }
    }
    return w;
}

type Parsed<T> = { ok: true; value: T; next: number } | { ok: false; error: Intent };

/**
 * `<amount> <token>?` starting at words[i]. With `defaultToken`, a missing token means that token;
 * without it, a missing token is an error. `howto` ends the error messages.
 */
function amountAt(words: string[], i: number, howto: string, defaultToken: Token | null = null): Parsed<Amount> {
    let amountText: string;
    let dollar = false;
    const w = words[i] ?? '';
    if (/^\$?\d*\.?\d+$/.test(w) || /^\$?\d+\.?$/.test(w)) {
        dollar = w.startsWith('$');
        amountText = w.replace(/^\$/, '').replace(/\.$/, '');
        i++;
    } else {
        const n = numberWords(words, i);
        if (n === null) {
            return { ok: false, error: err('no_amount', `How much? ${howto}`) };
        }
        [amountText] = n;
        i += n[1];
    }

    let token: Token | null = dollar ? 'USDC' : null;
    const t = words[i];
    if (t === 'sol' || t === 'usdc' || t === 'dollar' || t === 'dollars') {
        const said: Token = t === 'sol' ? 'SOL' : 'USDC';
        if (token !== null && token !== said) {
            return { ok: false, error: err('no_token', 'Say SOL or USDC, not both.') };
        }
        token = said;
        i++;
    }
    token ??= defaultToken;
    if (token === null) {
        return { ok: false, error: err('no_token', `Say SOL or USDC. ${howto}`) };
    }

    try {
        return { ok: true, value: { token, amount: parseAmount(amountText, DECIMALS[token]), amountText }, next: i };
    } catch (e) {
        if (e instanceof AmountError && e.code === 'too_many_decimals') {
            return {
                ok: false,
                error: err('too_many_decimals', `${token} has at most ${DECIMALS[token]} decimal places.`),
            };
        }
        if (e instanceof AmountError && e.code === 'too_large') {
            return { ok: false, error: err('too_large', 'That amount is too large.') };
        }
        return { ok: false, error: err('no_amount', `How much? ${howto}`) };
    }
}

type ContactMatch =
    | { kind: 'one'; contact: AppContact }
    | { kind: 'many'; spoken: string; candidates: AppContact[] }
    | { kind: 'error'; error: Intent };

/** A spoken name -> one app contact, several (first-word match), or an error with a suggestion. */
function matchContact(name: string, contacts: readonly AppContact[], howto: string): ContactMatch {
    if (name === '') {
        return { kind: 'error', error: err('no_name', `Who? ${howto}`) };
    }
    if (contacts.length === 0) {
        return {
            kind: 'error',
            error: err('no_contacts', 'There are no app contacts yet. Add one under App contacts first.'),
        };
    }
    const exact = contacts.find((c) => c.name.toLowerCase() === name);
    if (exact) {
        return { kind: 'one', contact: exact };
    }
    // Whole-word prefix: "jack" matches "Jack Miller" and "Jack Chen", never "Jackson".
    const byFirstWords = contacts.filter((c) => c.name.toLowerCase().startsWith(`${name} `));
    if (byFirstWords.length >= 2) {
        return { kind: 'many', spoken: name, candidates: byFirstWords };
    }
    if (byFirstWords.length === 1 && byFirstWords[0]) {
        const s = byFirstWords[0];
        return { kind: 'error', error: err('did_you_mean', `Did you mean ${s.name}?`, s) };
    }
    const near = contacts.filter((c) => editDistance(c.name.toLowerCase(), name) <= 1);
    if (near.length === 1 && near[0]) {
        return { kind: 'error', error: err('did_you_mean', `Did you mean ${near[0].name}?`, near[0]) };
    }
    return { kind: 'error', error: err('unknown_name', `There is no app contact named ${name}.`) };
}

/** Several matches where the app has no chooser (requests): ask the user to say the full name. */
const whichOne = (m: { spoken: string; candidates: AppContact[] }): Intent =>
    err('ambiguous_name', `Which ${m.spoken}: ${m.candidates.map((c) => c.name).join(' or ')}? Say the full name.`);

const tokenIn = (words: string[]): Token | null =>
    words.includes('usdc') || words.includes('dollars') ? 'USDC' : words.includes('sol') ? 'SOL' : null;

const HELP_RE = /^(help|commands|what can (i|you) (say|do|ask)|what commands are there|(list|show)( the)? commands)$/;
const REPEAT_RE = /^(repeat( that| it| the last one)?( again)?|say (that|it) again|what did you say|come again)$/;
const CANCEL_RE = /^(cancel|stop|abort|never ?mind)( (it|that|this|sending|the send|talking|speaking))?$/;
const LOCK_RE = /^lock( (my|the))?( wallet| device)?( now)?$/;
const ADDRESS_RE = /^((what is|what's|whats|say|read|speak) )?my( wallet)? address( phrase)?$/;
const CONTACTS_RE = [
    /^((who are|who's in|who is in|list|read|say|what are) )?my contacts$/,
    /^(what|which|how many) contacts do i have$/,
];
const STAKED_RE = /\b(staked|staking)\b|\bmy stakes?\b/;
const ACTIVITY_RE = [
    /\b(last|latest|recent|previous) (transaction|transactions|transfer|transfers|payment|payments|activity)\b/,
    /\b(recent activity|transaction history|my history|my activity)\b/,
];
const REQUESTS_RE = [
    /^((do|did) i have|are there|have i got) any( payment| pending| new)? requests$/,
    /^((show|list|check|read)( me)? )?my( payment| pending)? requests$/,
    /^(any|pending|any pending)( payment)? requests$/,
];
const PAID_RE = /^(did|has) (.+?) (pay|paid) me( yet| back)?$/;
const BALANCE_RE = [
    /\bbalances?\b/,
    /^how much( sol| usdc| money)?( do i have| have i got| is in my wallet| is on the device)( left)?$/,
];

/** Questions and control words that need no amount (or only a name, for "did Max pay me"). */
function fixedPhrase(words: string[], contacts: readonly AppContact[]): Intent | null {
    const s = words.join(' ');
    if (HELP_RE.test(s)) {
        return { kind: 'help' };
    }
    if (REPEAT_RE.test(s)) {
        return { kind: 'repeat' };
    }
    if (CANCEL_RE.test(s)) {
        return { kind: 'cancel' };
    }
    if (LOCK_RE.test(s)) {
        return { kind: 'lock' };
    }
    if (ADDRESS_RE.test(s)) {
        return { kind: 'address' };
    }
    if (CONTACTS_RE.some((r) => r.test(s))) {
        return { kind: 'contacts' };
    }
    if (words[0] !== 'stake' && words[0] !== 'unstake' && STAKED_RE.test(s)) {
        return { kind: 'staked' };
    }
    if (ACTIVITY_RE.some((r) => r.test(s))) {
        return { kind: 'activity' };
    }
    if (REQUESTS_RE.some((r) => r.test(s))) {
        return { kind: 'requests', contact: null };
    }
    const paid = PAID_RE.exec(s);
    if (paid?.[2] !== undefined) {
        const m = matchContact(paid[2], contacts, 'Say it like: did Henry pay me.');
        if (m.kind === 'one') {
            return { kind: 'requests', contact: m.contact };
        }
        return m.kind === 'many' ? whichOne(m) : m.error;
    }
    if (BALANCE_RE.some((r) => r.test(s))) {
        return { kind: 'balance', token: tokenIn(words) };
    }
    return null;
}

const STAKE_HOWTO = 'Say it like: stake 2 SOL.';
const REQUEST_HOWTO = 'Say it like: request 5 USDC from Henry.';

function parseStake(words: string[], v: number): Intent {
    const a = amountAt(words, v + 1, STAKE_HOWTO, 'SOL');
    if (!a.ok) {
        return a.error;
    }
    if (a.value.token !== 'SOL') {
        return err('only_sol', 'Only SOL can be staked.');
    }
    return { kind: 'stake', amount: a.value.amount, amountText: a.value.amountText };
}

function parseRequest(words: string[], v: number, contacts: readonly AppContact[]): Intent {
    let a: Parsed<Amount>;
    let name: string;
    if (words[v] === 'ask') {
        // ask <name> for <amount> <token>
        const f = words.indexOf('for', v + 1);
        if (f < 0) {
            return err('no_amount', `How much? ${REQUEST_HOWTO}`);
        }
        name = words.slice(v + 1, f).join(' ');
        a = amountAt(words, f + 1, REQUEST_HOWTO);
    } else {
        // request <amount> <token> from <name>
        a = amountAt(words, v + 1, REQUEST_HOWTO);
        if (a.ok && words[a.next] !== 'from') {
            return err('no_name', `Who from? ${REQUEST_HOWTO}`);
        }
        name = a.ok ? words.slice(a.next + 1).join(' ') : '';
    }
    if (!a.ok) {
        return a.error;
    }
    const m = matchContact(name, contacts, REQUEST_HOWTO);
    if (m.kind === 'one') {
        return { kind: 'request', contact: m.contact, ...a.value };
    }
    return m.kind === 'many' ? whichOne(m) : m.error;
}

export function parseIntent(text: string, contacts: readonly AppContact[]): Intent {
    const words = stripLead(normalize(text));

    const fixed = fixedPhrase(words, contacts);
    if (fixed !== null) {
        return fixed;
    }
    const unstake = words.indexOf('unstake');
    if (unstake >= 0) {
        const rest = words.slice(unstake + 1);
        return { kind: 'unstake', all: rest.includes('all') || rest.includes('everything') };
    }
    const stake = words.indexOf('stake');
    if (stake >= 0) {
        return parseStake(words, stake);
    }
    const request = words.indexOf('request');
    if (request >= 0 || words[0] === 'ask') {
        return parseRequest(words, request >= 0 ? request : 0, contacts);
    }

    const v = words.findIndex((w) => VERBS.has(w));
    if (v < 0) {
        return err('not_a_command', `I didn't understand that. ${HELP_HINT}`);
    }
    const a = amountAt(words, v + 1, HOWTO);
    if (!a.ok) {
        return a.error;
    }
    // recipient: everything after "to"
    if (words[a.next] !== 'to') {
        return err('no_name', `Who to? ${HOWTO}`);
    }
    const m = matchContact(words.slice(a.next + 1).join(' '), contacts, HOWTO);
    if (m.kind === 'one') {
        return { kind: 'send', contact: m.contact, ...a.value };
    }
    if (m.kind === 'many') {
        return { kind: 'ambiguous', spoken: m.spoken, candidates: m.candidates, ...a.value };
    }
    if (m.error.kind === 'error' && m.error.code === 'no_name') {
        return err('no_name', `Who to? ${HOWTO}`);
    }
    return m.error;
}
