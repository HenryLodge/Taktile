// Deterministic intent parser: "send 5 USDC to Henry" -> {token, amount, contact}. No LLM, no
// network. The input is untrusted text (typed, or from speech-to-text); a mistake here can only make
// the app build the wrong transaction, which the device then announces truthfully (I1, I3).
//
// Grammar, after normalizing:   (send|pay|transfer|give) <amount> <token>? to <name>
//   amount: digits ("0.01", ".5", "1,000") or number words ("two point five", "one hundred twenty")
//   token:  sol | usdc; "$5" and "5 dollars" mean USDC; no token at all is refused ("Say SOL or USDC").

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
    | 'did_you_mean';

export type Intent =
    | { kind: 'send'; token: Token; amount: bigint; amountText: string; contact: AppContact }
    | { kind: 'error'; code: IntentErrorCode; message: string; suggestion?: AppContact }
    /** The name is the first word(s) of two or more contacts ("Jack" -> Jack Miller, Jack Chen). The
     *  app asks which one (src/disambiguate.ts); nothing is sent until the user picks one of these. */
    | { kind: 'ambiguous'; token: Token; amount: bigint; amountText: string; spoken: string; candidates: AppContact[] };

const VERBS = new Set(['send', 'pay', 'transfer', 'give']);
const FILLER = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'please', 'okay', 'ok']);
const HOWTO = 'Say it like: send 5 USDC to Henry.';

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

export function parseIntent(text: string, contacts: readonly AppContact[]): Intent {
    const words = normalize(text);
    const v = words.findIndex((w) => VERBS.has(w));
    if (v < 0) {
        return err('not_a_command', `I didn't understand that. ${HOWTO}`);
    }
    let i = v + 1;

    // amount
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
            return err('no_amount', `How much? ${HOWTO}`);
        }
        [amountText] = n;
        i += n[1];
    }

    // token
    let token: Token | null = dollar ? 'USDC' : null;
    const t = words[i];
    if (t === 'sol' || t === 'usdc' || t === 'dollar' || t === 'dollars') {
        const said: Token = t === 'sol' ? 'SOL' : 'USDC';
        if (token !== null && token !== said) {
            return err('no_token', 'Say SOL or USDC, not both.');
        }
        token = said;
        i++;
    }
    if (token === null) {
        return err('no_token', `Say SOL or USDC. ${HOWTO}`);
    }

    let amount: bigint;
    try {
        amount = parseAmount(amountText, DECIMALS[token]);
    } catch (e) {
        if (e instanceof AmountError && e.code === 'too_many_decimals') {
            return err('too_many_decimals', `${token} has at most ${DECIMALS[token]} decimal places.`);
        }
        if (e instanceof AmountError && e.code === 'too_large') {
            return err('too_large', 'That amount is too large.');
        }
        return err('no_amount', `How much? ${HOWTO}`);
    }

    // recipient: everything after "to"
    if (words[i] !== 'to') {
        return err('no_name', `Who to? ${HOWTO}`);
    }
    const name = words.slice(i + 1).join(' ');
    if (name === '') {
        return err('no_name', `Who to? ${HOWTO}`);
    }
    if (contacts.length === 0) {
        return err('no_contacts', 'There are no app contacts yet. Add one under App contacts first.');
    }
    const exact = contacts.find((c) => c.name.toLowerCase() === name);
    if (exact) {
        return { kind: 'send', token, amount, amountText, contact: exact };
    }
    // Whole-word prefix: "jack" matches "Jack Miller" and "Jack Chen", never "Jackson".
    const byFirstWords = contacts.filter((c) => c.name.toLowerCase().startsWith(`${name} `));
    if (byFirstWords.length >= 2) {
        return { kind: 'ambiguous', token, amount, amountText, spoken: name, candidates: byFirstWords };
    }
    if (byFirstWords.length === 1 && byFirstWords[0]) {
        return err('did_you_mean', `Did you mean ${byFirstWords[0].name}?`, byFirstWords[0]);
    }
    const near = contacts.filter((c) => editDistance(c.name.toLowerCase(), name) <= 1);
    if (near.length === 1 && near[0]) {
        return err('did_you_mean', `Did you mean ${near[0].name}?`, near[0]);
    }
    return err('unknown_name', `There is no app contact named ${name}.`);
}
