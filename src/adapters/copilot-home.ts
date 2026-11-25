import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCall } from '../types.ts';

export async function prepareCopilotLaunch(
  scratch: string,
  call: Pick<AgentCall, 'cwd' | 'evidenceDir'>,
  env: NodeJS.ProcessEnv,
) {
  const work = join(scratch, 'work');
  const home = join(scratch, 'copilot-home');
  await Promise.all([mkdir(work, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const [cwd, source, evidence] = await Promise.all([
    realpath(work), realpath(call.cwd), call.evidenceDir ? realpath(call.evidenceDir) : undefined,
  ]);
  const roots = evidence && evidence !== source ? [source, evidence] : [source];
  // --add-dir would additionally trust agent/skill configuration inside the
  // target. Saved directory permissions grant access without importing it.
  const permissions = { locations: { [cwd]: { allowed_directories: roots } } };
  const settings = { disableAllHooks: true, autoUpdate: false, remoteExport: false, customAgents: { defaultLocalOnly: true } };
  await Promise.all([
    writeFile(join(home, 'permissions-config.json'), JSON.stringify(permissions), { mode: 0o600 }),
    writeFile(join(home, 'settings.json'), JSON.stringify(settings), { mode: 0o600 }),
  ]);
  return {
    cwd,
    env: {
      ...env, COPILOT_HOME: home, COPILOT_PLUGIN_DIR_ONLY: 'true', COPILOT_AUTO_UPDATE: 'false',
      COPILOT_DISABLE_LOGIN_SHELL_ENV: '1', USE_TGREP: 'false',
    },
  };
}
