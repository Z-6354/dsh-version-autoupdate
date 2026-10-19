import type { Context } from '@deepseek-ai/cordis';
import type { InstallationSourceInput } from './source-detection.js';
/** Collects source evidence from the active DSH root for source detection. */
export declare function collectInstallationEvidence(ctx: Context, root: string | null): Promise<InstallationSourceInput>;
//# sourceMappingURL=source-evidence.d.ts.map