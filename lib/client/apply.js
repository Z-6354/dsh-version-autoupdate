import { Widget } from './widget';
/** Cordis fiber id — must match package name for ModuleLoader. */
export const name = 'dsh-version-autoupdate';
/** Wait for slots before registering the floating capsule. */
export const inject = ['slots'];
export function apply(ctx) {
    const slots = (ctx.slots
        ?? ctx.get('slots'));
    if (!slots) {
        console.warn('[dsh-version-autoupdate] slots missing — floating capsule not registered');
        return;
    }
    const effect = ctx.effect;
    const register = () => slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'dsh-version-autoupdate', order: 20 }, () => Widget()));
    if (typeof effect === 'function')
        effect(() => register(), 'dsh-version-autoupdate: floating capsule');
    else
        register();
}
//# sourceMappingURL=apply.js.map