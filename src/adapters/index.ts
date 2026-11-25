import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { copilotAdapter } from './copilot.ts';
import type { Role } from '../types.ts';

const factories = { claude: claudeAdapter, codex: codexAdapter, copilot: copilotAdapter };
export type Provider = keyof typeof factories;
export type ProviderModels = Partial<Record<`${Provider}Model`, string>>;
export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && Object.hasOwn(factories, value);

export function bindProvider(name: string, model?: string) {
  if (!isProvider(name)) throw new Error('Unsupported saved adapter: ' + name);
  return factories[name](model);
}

export function createAdapters(options: ProviderModels = {}, roles: Record<Role, Provider> = { A: 'claude', B: 'codex' }) {
  const bind = (role: Role) => bindProvider(roles[role], options[`${roles[role]}Model`]);
  return { A: bind('A'), B: bind('B') };
}
