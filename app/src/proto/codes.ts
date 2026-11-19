// Protocol constants, mirrored from docs/SERIAL_PROTOCOL.md and core/include/tk_proto.h.

export const MSG = {
    HELLO: 0x01,
    GET_PUBKEY: 0x02,
    SETUP: 0x03,
    UNLOCK: 0x04,
    SIGN_REQUEST: 0x10,
    CONTACT_ADD: 0x30,
    CONTACT_LIST_COUNT: 0x31,
    CONTACT_REMOVE: 0x32,
    SPEAK_ADDRESS: 0x41,
    SPEAK_CONTACTS: 0x42,
    LOCK: 0x43,
    CANCEL: 0x7e,
    EVENT: 0xf0,
    ERROR: 0xff,
} as const;

export const RESPONSE_BIT = 0x80;
export const PROTO_VERSION = 1;

export const STATUS = {
    OK: 0x00,
    REJECTED_BY_USER: 0x01,
    UNKNOWN_RECIPIENT: 0x02,
    PARSE_UNSUPPORTED: 0x03,
    LOCKED_OUT: 0x04,
    NO_WALLET: 0x05,
    BUSY: 0x06,
    CANCELLED: 0x07,
    WALLET_EXISTS: 0x08,
    CONTACTS_FULL: 0x09,
    CONTACT_EXISTS: 0x0a,
    NOT_FOUND: 0x0b,
    DEVICE_ERROR: 0x0c,
} as const;

export const EVENT = {
    ANNOUNCING: 0x01,
    AWAITING_PIN: 0x02,
    AWAITING_CONFIRM: 0x03,
    SIGNING: 0x04,
} as const;

export const PROTO_ERROR = {
    BAD_FRAME: 0x01,
    UNKNOWN_TYPE: 0x02,
    BAD_PAYLOAD: 0x03,
    TOO_LARGE: 0x04,
} as const;

/** HELLO state byte. */
export const DEVICE_STATE = { NO_WALLET: 0, LOCKED: 1, UNLOCKED: 2 } as const;
export type DeviceState = (typeof DEVICE_STATE)[keyof typeof DEVICE_STATE];

export type StatusName = keyof typeof STATUS;
export type EventName = keyof typeof EVENT;

function reverse<T extends Record<string, number>>(m: T): Map<number, keyof T & string> {
    return new Map(Object.entries(m).map(([k, v]) => [v, k as keyof T & string]));
}
const MSG_NAMES = reverse(MSG);
const STATUS_NAMES = reverse(STATUS);
const EVENT_NAMES = reverse(EVENT);
const ERROR_NAMES = reverse(PROTO_ERROR);

const hex = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

export function msgName(type: number): string {
    const base = MSG_NAMES.get(type) ?? MSG_NAMES.get(type & ~RESPONSE_BIT);
    if (base === undefined) {
        return hex(type);
    }
    return type !== MSG.EVENT && type !== MSG.ERROR && type & RESPONSE_BIT ? `${base} reply` : base;
}
export const statusName = (s: number): string => STATUS_NAMES.get(s) ?? hex(s);
export const eventName = (e: number): string => EVENT_NAMES.get(e) ?? hex(e);
export const errorName = (e: number): string => ERROR_NAMES.get(e) ?? hex(e);

/** One short sentence per status, for the live region and the log. */
export const STATUS_TEXT: Record<StatusName, string> = {
    OK: 'Done.',
    REJECTED_BY_USER: 'Rejected on the device.',
    UNKNOWN_RECIPIENT: 'The device refused: unknown recipient.',
    PARSE_UNSUPPORTED: 'The device refused: it cannot sign this transaction.',
    LOCKED_OUT: 'Too many wrong PINs. The device wiped its wallet.',
    NO_WALLET: 'The device has no wallet yet. Set it up first.',
    BUSY: 'The device is busy with another request.',
    CANCELLED: 'Cancelled.',
    WALLET_EXISTS: 'The device already has a wallet.',
    CONTACTS_FULL: 'The device contact book is full.',
    CONTACT_EXISTS: 'That contact is already on the device.',
    NOT_FOUND: 'No such contact on the device.',
    DEVICE_ERROR: "The device can't do this safely. Check the device.",
};

export function statusText(s: number): string {
    const name = STATUS_NAMES.get(s);
    return name === undefined ? `Unexpected device status ${hex(s)}.` : STATUS_TEXT[name];
}

/** What the screen and live region say for each device event (never content the user must verify). */
export const EVENT_TEXT: Record<EventName, string> = {
    ANNOUNCING: 'The device is speaking.',
    AWAITING_PIN: 'Enter your PIN on the device.',
    AWAITING_CONFIRM: 'Press Confirm or Reject on the device.',
    SIGNING: 'Signing.',
};

export function eventText(e: number): string {
    const name = EVENT_NAMES.get(e);
    return name === undefined ? `Device event ${hex(e)}.` : EVENT_TEXT[name];
}

/** Requests that run an on-device flow; only one may be in flight. */
export const FLOW_TYPES: ReadonlySet<number> = new Set([
    MSG.SETUP,
    MSG.UNLOCK,
    MSG.SIGN_REQUEST,
    MSG.CONTACT_ADD,
    MSG.CONTACT_REMOVE,
    MSG.SPEAK_ADDRESS, // may run PIN entry first
    MSG.SPEAK_CONTACTS,
    MSG.LOCK, // plays "wallet locked"
]);
