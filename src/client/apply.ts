import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { Widget } from './widget';

interface ClientSlotLike {
  inject(key: string, cb: () => unknown): unknown;
  register(opts: { name: string; id?: string; order?: number }, render: (props: Record<string, unknown>) => unknown): unknown;
}

/** Cordis fiber id — must match package name for ModuleLoader. */
export const name = 'dsh-version-autoupdate';
/** Wait for slots before registering the floating capsule. */
export const inject = ['slots'];

export function apply(ctx: ClientContext): void {
  const slots = ((ctx as { slots?: ClientSlotLike }).slots
    ?? ctx.get('slots')) as ClientSlotLike | undefined;
  if (!slots) {
    console.warn('[dsh-version-autoupdate] slots missing — floating capsule not registered');
    return;
  }
  const effect = (ctx as { effect?: (fn: () => unknown, label?: string) => unknown }).effect;
  const register = () =>
    slots.inject('shell.overlay', () =>
      slots.register(
        { name: 'shell.overlay', id: 'dsh-version-autoupdate', order: 20 },
        () => Widget(),
      ),
    );
  if (typeof effect === 'function') effect(() => register(), 'dsh-version-autoupdate: floating capsule');
  else register();
}
