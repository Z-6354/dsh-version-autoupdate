export type UpdateChannelTransport = 'auto' | 'official';
export type ResolveUpdateChannelResult = {
    ok: true;
    transport: UpdateChannelTransport;
    password: string | null;
    /** Safe for logs / UI (never includes the password). */
    note: string;
} | {
    ok: false;
    cancelled?: boolean;
    error: string;
};
export declare const MIRROR_ASK_ID = "dsh-mirror-channel";
export declare const MIRROR_PASSWORD_ASK_ID = "dsh-mirror-password";
export declare const MIRROR_OPTION_PASSWORD = "\u8F93\u5165\u955C\u50CF\u5BC6\u7801";
export declare const MIRROR_OPTION_OFFICIAL = "\u4EC5\u7528\u5B98\u65B9\u6E90";
export declare const MIRROR_OPTION_CANCEL = "\u53D6\u6D88\u66F4\u65B0";
export declare const MIRROR_OPTION_CONFIRM_PASSWORD = "\u786E\u8BA4\u5BC6\u7801";
/** Minimal ask surface (matches ctx.userQuestions.ask). */
export type MirrorChannelAsker = {
    ask(request: {
        questions: Array<{
            id: string;
            header?: string;
            question: string;
            detail?: string;
            options?: Array<{
                label: string;
                description?: string;
            }>;
        }>;
        agent?: unknown;
        signal?: AbortSignal;
    }): Promise<{
        answers: Array<{
            id: string;
            selected: string[];
            custom?: string;
        }>;
    }>;
};
/** Probe mirror with transport=mirror. Returns false on auth failure; throws on network/other. */
export declare function defaultVerifyMirrorPassword(password: string): Promise<boolean>;
/**
 * Mirror-first channel selection for explicit updates (never for /status).
 *
 * Code path (not agent-decided):
 * 1. Read local credentials → verify when possible → auto
 * 2. Missing / auth-fail → ctx.userQuestions.ask (UI) for password / official / cancel
 * 3. Save password when user submits one
 */
export declare function resolveUpdateChannel(input: {
    dshHome?: string;
    /** Host userQuestions service (or test mock). Required when password is missing/invalid. */
    asker?: MirrorChannelAsker | null;
    agent?: unknown;
    signal?: AbortSignal;
    /** Injected in tests; defaults to a live mirror probe. */
    verifyMirrorPassword?: (password: string) => Promise<boolean>;
}): Promise<ResolveUpdateChannelResult>;
//# sourceMappingURL=resolve-update-channel.d.ts.map