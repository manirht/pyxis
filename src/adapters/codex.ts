import type { AgentAdapter } from '../types.ts';
import { invokeProvider, parseOutput, type InvokeProvider } from './process.ts';

export function codexAdapter(model?: string, invoke: InvokeProvider = invokeProvider): AgentAdapter {
  return async (call, signal) => {
    // The built-in read-only profile allows broad reads. Limit shell commands
    // to the checkout, the private working directory and essential OS files.
    const roots = [call.cwd];
    if (call.evidenceDir && call.evidenceDir !== call.cwd) roots.push(call.evidenceDir);
    const sourceGrants = roots.map(root => JSON.stringify(root) + '="read"');
    const filesystem = '{":minimal"="read",":workspace_roots"="read",' + sourceGrants.join(',') + '}';
    const args = [
      '--no-daemon', '--ask-for-approval', 'never', 'exec',
      '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--color', 'never', '--output-schema', call.schemaPath,
      '-c', 'default_permissions="rca"',
      '-c', 'permissions.rca.filesystem=' + filesystem, '-c', 'permissions.rca.network.enabled=false',
      '-c', 'mcp_servers={}', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
      '-c', 'allow_login_shell=false', '-c', 'shell_environment_policy.inherit="core"',
      '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent',
      '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'skill_mcp_dependency_install',
      '--enable', 'skip_host_skill_discovery',
    ];
    if (process.platform === 'win32') {
      args.push('--enable', 'prefer_mxc', '-c', 'windows.sandbox="elevated"');
    }
    if (model) args.push('--model', model);
    // Without --json, exec writes only its final answer to stdout. --json
    // would deliver a sequence of tool events and model messages instead.
    args.push('-');
    return parseOutput(await invoke('codex', args, call, signal), 'Codex');
  };
}
