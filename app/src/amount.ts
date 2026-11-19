// Exact token amounts: decimal text <-> integer base units (bigint). Never floating point.

export const U64_MAX = (1n << 64n) - 1n;
export const DECIMALS = { SOL: 9, USDC: 6 } as const;
export type Token = keyof typeof DECIMALS;

export type AmountErrorCode = 'not_a_number' | 'too_many_decimals' | 'too_large';

export class AmountError extends Error {
    readonly code: AmountErrorCode;
    constructor(code: AmountErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

/** "0.01" with 9 decimals -> 10_000_000n. Refuses junk, signs, exponents, extra decimals, > u64. */
export function parseAmount(text: string, decimals: number): bigint {
    const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
    if (m === null || ((m[1] ?? '') === '' && (m[2] ?? '') === '')) {
        throw new AmountError('not_a_number', `not an amount: ${text}`);
    }
    const whole = m[1] || '0';
    const frac = (m[2] ?? '').replace(/0+$/, '');
    if (frac.length > decimals) {
        throw new AmountError('too_many_decimals', `at most ${decimals} decimal places`);
    }
    const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
    if (value > U64_MAX) {
        throw new AmountError('too_large', 'amount too large');
    }
    return value;
}

/** 10_000_000n with 9 decimals -> "0.01" (trailing zeros dropped). */
export function formatAmount(value: bigint, decimals: number): string {
    const unit = 10n ** BigInt(decimals);
    const whole = value / unit;
    const frac = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
}
