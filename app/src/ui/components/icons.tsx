// Small inline icons (24 px grid, 1.75 stroke). Decorative: always aria-hidden; the text says it.

import type { ReactNode } from 'react';

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
    return (
        <svg
            className="icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {children}
        </svg>
    );
}

/** The mark: a braille cell, the six dots of tactile reading, three of them raised. */
export function Logo({ size = 28 }: { size?: number }) {
    return (
        <svg className="logo" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
            <rect width="28" height="28" rx="8" fill="var(--ink)" />
            <circle cx="10" cy="8" r="2.4" fill="var(--green-bright)" />
            <circle cx="18" cy="8" r="2.4" fill="#ffffff" opacity="0.28" />
            <circle cx="10" cy="14" r="2.4" fill="#ffffff" />
            <circle cx="18" cy="14" r="2.4" fill="#ffffff" />
            <circle cx="10" cy="20" r="2.4" fill="#ffffff" opacity="0.28" />
            <circle cx="18" cy="20" r="2.4" fill="#ffffff" opacity="0.28" />
        </svg>
    );
}

export const MicIcon = ({ size }: { size?: number }) => (
    <Icon size={size}>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </Icon>
);

export const CheckIcon = () => (
    <Icon>
        <path d="M20 6 9 17l-5-5" />
    </Icon>
);

export const AlertIcon = () => (
    <Icon>
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </Icon>
);

export const ExternalIcon = () => (
    <Icon size={16}>
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Icon>
);

export const CopyIcon = () => (
    <Icon size={16}>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Icon>
);

export const UsbIcon = () => (
    <Icon>
        <path d="M12 3v14M9 6l3-3 3 3M7 10v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
        <circle cx="12" cy="19" r="2" />
    </Icon>
);

export const ChipIcon = () => (
    <Icon>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </Icon>
);

export const LockIcon = ({ open }: { open?: boolean }) => (
    <Icon size={16}>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d={open ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
    </Icon>
);

export const ArrowLeftIcon = () => (
    <Icon size={16}>
        <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
);

export const ArrowDownIcon = () => (
    <Icon>
        <path d="M12 5v14M6 13l6 6 6-6" />
    </Icon>
);

export const GridIcon = () => (
    <Icon size={16}>
        <rect x="4" y="4" width="6" height="6" rx="1.5" />
        <rect x="14" y="4" width="6" height="6" rx="1.5" />
        <rect x="4" y="14" width="6" height="6" rx="1.5" />
        <rect x="14" y="14" width="6" height="6" rx="1.5" />
    </Icon>
);
