export type CredentialDecision = 'ask' | 'skip' | 'official' | 'cancel';
export type CredentialReason = 'first-use' | 'authentication-failed';
export interface CredentialOptions {
    /** Real DSH home supplied by the integration layer. This takes precedence over all fallbacks. */
    dshHome?: string;
    /** @deprecated Use dshHome; this is retained as an explicit caller-provided home. */
    home?: string;
    env?: Record<string, string | undefined>;
    /** Test or deployment fallback, used only when no explicit DSH home is supplied. */
    defaultHome?: string;
    reason?: CredentialReason;
    choose: (reason: CredentialReason) => Promise<CredentialDecision>;
    ask: () => Promise<string>;
    /** Verifies a candidate against the mirror before it can replace the stored password. */
    verifyPassword?: (password: string) => Promise<boolean>;
}
/** Resolve storage from the integration-provided DSH home, then documented fallbacks. */
export declare function resolveCredentialHome(explicit?: string, env?: Record<string, string | undefined>, fallback?: string): string;
/** Read the optional mirror password; absent or malformed files behave as unset. */
export declare function readMirrorPassword(home: string): Promise<string | null>;
/** Persist only the mirror password using a same-directory replacement and guaranteed cleanup. */
export declare function saveMirrorPassword(home: string, password: string): Promise<void>;
/** Obtain a password only during an explicit operation; status polling must not call this function. */
export declare function ensureMirrorPassword(options: CredentialOptions): Promise<string | null>;
//# sourceMappingURL=credentials.d.ts.map