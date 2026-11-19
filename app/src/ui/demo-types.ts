// The shape of the demo-only module (loaded by npm run demo builds only). Kept apart so normal builds
// reference only these types, never the module itself.

import type { ComponentType } from 'react';

export interface DemoModule {
    /** Shown above both views while the demo is active. */
    Banner: ComponentType;
    /** The toggle panel on /data. */
    Panel: ComponentType;
}
