import type { ReactNode } from 'react';

export function Panel({
    id,
    title,
    lead,
    children,
    aside,
}: {
    id: string;
    title: string;
    lead?: ReactNode;
    children: ReactNode;
    /** Shown at the right of the title (a status chip). */
    aside?: ReactNode;
}) {
    return (
        <section id={id} className="panel" aria-labelledby={`${id}-h`}>
            <div className="panel-head">
                <h2 id={`${id}-h`} tabIndex={-1}>
                    {title}
                </h2>
                {aside}
            </div>
            {lead !== undefined && <p className="panel-lead">{lead}</p>}
            {children}
        </section>
    );
}
