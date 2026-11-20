// A value shown as text, with a Copy button (a payment request's Blink link). The result is announced
// in the live region; the value stays selectable for screen-reader users who copy by hand.

import { useState } from 'react';

import { alertUser, say } from '../../announce.ts';
import { Button } from './Button.tsx';

export function CopyField({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false);
    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            say('Copied.');
        } catch {
            alertUser('Copying was blocked by the browser. Select the link text and copy it by hand.');
        }
    }
    return (
        <span className="copy-field">
            <code className="addr">{value}</code>
            <Button size="sm" variant="ghost" onPress={copy} aria-label={`${label}: ${value}`}>
                {copied ? 'Copied' : label}
            </Button>
        </span>
    );
}
