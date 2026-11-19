// Buttons are never `disabled`: a disabled button leaves the tab order, so a screen-reader user can't
// find it or learn why it is off. They get aria-disabled instead, and the press is ignored.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'onClick'> {
    enabled?: boolean;
    onPress?: () => void | Promise<void>;
    variant?: 'primary' | 'secondary' | 'ghost';
    size?: 'md' | 'sm';
    icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { enabled = true, onPress, variant = 'secondary', size = 'md', icon, className, children, type, ...rest },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type ?? 'button'}
            className={['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className ?? ''].join(' ').trim()}
            aria-disabled={!enabled}
            onClick={(e) => {
                if (!enabled) {
                    e.preventDefault(); // also stops a submit button from submitting
                    return;
                }
                void onPress?.();
            }}
            {...rest}
        >
            {icon}
            {children}
        </button>
    );
});
