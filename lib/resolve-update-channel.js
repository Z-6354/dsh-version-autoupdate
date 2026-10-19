import { readMirrorPassword, resolveCredentialHome, saveMirrorPassword, } from './credentials.js';
import { MirrorClient, MirrorClientError } from './mirror-client.js';
export const MIRROR_ASK_ID = 'dsh-mirror-channel';
export const MIRROR_PASSWORD_ASK_ID = 'dsh-mirror-password';
export const MIRROR_OPTION_PASSWORD = '输入镜像密码';
export const MIRROR_OPTION_OFFICIAL = '仅用官方源';
export const MIRROR_OPTION_CANCEL = '取消更新';
export const MIRROR_OPTION_CONFIRM_PASSWORD = '确认密码';
/** Probe mirror with transport=mirror. Returns false on auth failure; throws on network/other. */
export async function defaultVerifyMirrorPassword(password) {
    const client = new MirrorClient({ password });
    try {
        await client.getLatest('github', 'mirror');
        return true;
    }
    catch (error) {
        if (error instanceof MirrorClientError && error.kind === 'auth')
            return false;
        throw error;
    }
}
async function probePassword(password, verify) {
    try {
        return (await verify(password)) ? 'ok' : 'auth';
    }
    catch {
        return 'network';
    }
}
function buildChannelQuestions(reason) {
    const question = reason === 'authentication-failed'
        ? '已保存的镜像密码无效。请重新输入镜像密码，或改用官方源。'
        : '更新前请选择下载通道（强制重装当前版本也需要选一次）。';
    return [{
            id: MIRROR_ASK_ID,
            header: 'DSH 更新通道',
            question,
            detail: [
                '• 「输入镜像密码」：下一屏标题下直接出现密码输入框。',
                '• 「仅用官方源」：不走镜像，可强制重装当前最新版。',
                '• 「取消更新」：中止。',
            ].join('\n'),
            options: [
                {
                    label: MIRROR_OPTION_PASSWORD,
                    description: '下一屏在标题下输入镜像密码',
                },
                {
                    label: MIRROR_OPTION_OFFICIAL,
                    description: '不用镜像；适合强制更新/测试',
                },
                {
                    label: MIRROR_OPTION_CANCEL,
                    description: '中止本次更新',
                },
            ],
        }];
}
/**
 * Optionless question → UI renders a block AnswerField under the title
 * (not a separate「其他」row beside options).
 */
function buildPasswordQuestions() {
    return [{
            id: MIRROR_PASSWORD_ASK_ID,
            header: 'DSH 更新',
            question: '请输入镜像密码',
            // No `detail`, no `options`: title + block input only.
        }];
}
async function askForPasswordText(input) {
    const answer = await input.asker.ask({
        questions: buildPasswordQuestions(),
        agent: input.agent,
        signal: input.signal,
    });
    const item = answer.answers.find((entry) => entry.id === MIRROR_PASSWORD_ASK_ID);
    if (!item)
        return { kind: 'cancel' };
    const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
    if (custom)
        return { kind: 'password', password: custom };
    return { kind: 'cancel' };
}
async function askUserForChannel(input) {
    const answer = await input.asker.ask({
        questions: buildChannelQuestions(input.reason),
        agent: input.agent,
        signal: input.signal,
    });
    const item = answer.answers.find((entry) => entry.id === MIRROR_ASK_ID);
    if (!item)
        return { kind: 'cancel' };
    const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
    // Typing password directly in the first prompt's custom field still works.
    if (custom)
        return { kind: 'password', password: custom };
    const selected = item.selected[0];
    if (selected === MIRROR_OPTION_OFFICIAL)
        return { kind: 'official' };
    if (selected === MIRROR_OPTION_CANCEL)
        return { kind: 'cancel' };
    if (selected === MIRROR_OPTION_PASSWORD) {
        const second = await askForPasswordText(input);
        if (second.kind === 'password')
            return second;
        return { kind: 'empty-password' };
    }
    return { kind: 'cancel' };
}
/**
 * Mirror-first channel selection for explicit updates (never for /status).
 *
 * Code path (not agent-decided):
 * 1. Read local credentials → verify when possible → auto
 * 2. Missing / auth-fail → ctx.userQuestions.ask (UI) for password / official / cancel
 * 3. Save password when user submits one
 */
export async function resolveUpdateChannel(input) {
    const home = resolveCredentialHome(input.dshHome);
    const verify = input.verifyMirrorPassword ?? defaultVerifyMirrorPassword;
    const password = await readMirrorPassword(home);
    if (password) {
        const probe = await probePassword(password, verify);
        if (probe === 'ok' || probe === 'network') {
            return {
                ok: true,
                transport: 'auto',
                password,
                note: probe === 'ok'
                    ? 'mirror password verified; preferring mirror with official fallback'
                    : 'mirror password available; preferring mirror with official fallback',
            };
        }
    }
    if (!input.asker) {
        return {
            ok: false,
            error: 'mirror password required, but userQuestions is unavailable to ask the user',
        };
    }
    const reason = password ? 'authentication-failed' : 'first-use';
    let decision;
    try {
        decision = await askUserForChannel({
            asker: input.asker,
            reason,
            agent: input.agent,
            signal: input.signal,
        });
    }
    catch (error) {
        return {
            ok: false,
            cancelled: true,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    if (decision.kind === 'cancel') {
        return {
            ok: false,
            cancelled: true,
            error: '用户取消了更新通道选择。若要强制重装当前版本，请再次更新并选择「仅用官方源」，或选择「输入镜像密码」后在标题下的输入框填写密码。',
        };
    }
    if (decision.kind === 'empty-password') {
        return {
            ok: false,
            cancelled: true,
            error: '未填写镜像密码。请再次更新：选择「输入镜像密码」后在标题下的输入框填写密码并确认；也可改选「仅用官方源」。',
        };
    }
    if (decision.kind === 'official') {
        return {
            ok: true,
            transport: 'official',
            password: null,
            note: 'user declined mirror via UI; using official only',
        };
    }
    const candidate = decision.password;
    const probe = await probePassword(candidate, verify);
    if (probe === 'auth') {
        return {
            ok: false,
            error: '镜像密码鉴权失败，未保存。请重试或改选「仅用官方源」。',
        };
    }
    await saveMirrorPassword(home, candidate);
    return {
        ok: true,
        transport: 'auto',
        password: candidate,
        note: probe === 'ok'
            ? 'mirror password saved and verified; preferring mirror with official fallback'
            : 'mirror password saved; preferring mirror with official fallback',
    };
}
//# sourceMappingURL=resolve-update-channel.js.map