import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import { Widget } from './widget';

interface ClientSlotLike {
  inject(key: string, cb: () => () => void): () => void;
  register(opts: { name: string; id?: string; order?: number }, render: ComponentType): () => void;
}

/** Cordis fiber id — must match package name for ModuleLoader. */
export const name = 'dsh-version-autoupdate';
/** Wait for slots before registering the floating capsule. */
export const inject = ['slots'];

export function apply(ctx: Context): void {
  const slots = ((ctx as { slots?: ClientSlotLike }).slots
    ?? ctx.get('slots')) as ClientSlotLike | undefined;
  if (!slots) {
    console.warn('[dsh-version-autoupdate] slots missing — floating capsule not registered');
    return;
  }
  const register = () =>
    slots.inject('shell.overlay', () =>
      slots.register(
        { name: 'shell.overlay', id: 'dsh-version-autoupdate', order: 20 },
        Widget,
      ),
    );
  ctx.effect(() => register(), 'dsh-version-autoupdate: floating capsule');
}
