import type { DshStatus } from './types';
export declare function shouldAutoExpand(st: DshStatus | null, waiting: boolean, userDismissed: boolean): boolean;
export declare function autoExpandResetKey(st: DshStatus | null, waiting: boolean): string;
export declare function statusColor(status: string, running: boolean, waiting: boolean, moduleUpdate?: boolean): string;
export declare function capsuleText(st: DshStatus | null, running: boolean, waiting: boolean): string;
export declare function capsuleTitle(st: DshStatus | null, running: boolean, waiting: boolean): string;
export declare function platformLabel(platform?: string, os?: string): string;
export declare function installMethodLabel(method?: string): string;
export declare function channelLabel(ch?: string): string;
export declare function shortenPath(p: string, max?: number): string;
export declare function policyLabel(st: DshStatus | null): string;
//# sourceMappingURL=status.d.ts.map