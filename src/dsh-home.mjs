import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Match DSH's configured home > nonblank DSH_HOME > ~/.dsh precedence. */
export function resolveDshHome(configured, env = process.env) {
  const override = env.DSH_HOME;
  let selected = configured ?? (override?.trim() ? override : join(homedir(), '.dsh'));
  if (selected === '~') selected = homedir();
  else if (selected.startsWith('~/') || selected.startsWith('~\\')) {
    selected = join(homedir(), selected.slice(2));
  }
  return resolve(selected);
}
