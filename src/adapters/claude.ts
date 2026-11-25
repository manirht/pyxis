import type { AgentAdapter } from '../types.ts';
import { invokeProvider, parseOutput, type InvokeProvider } from './process.ts';

export function claudeAdapter(model?: string, invoke: InvokeProvider = invokeProvider): AgentAdapter {
  return async (call, signal) => {
    const args = [
      '--print', '--output-format', 'json', '--json-schema', JSON.stringify(call.schema),
      '--no-session-persistence', '--safe-mode', '--restricted', '--permission-prompts', 'none',
      '--strict-mcp-config', '--tools', 'Read,Glob,Grep', '--add-dir', call.cwd,
    ];
    if (call.evidenceDir && call.evidenceDir !== call.cwd) args.push(call.evidenceDir);
    if (model) args.push('--model', model);
    const output = parseOutput(await invoke('claude', args, call, signal), 'Claude Code', false);
    if (output === null || typeof output !== 'object' || !('structured_output' in output)
      || output.structured_output == null || ('is_error' in output && output.is_error === true)
      || ('subtype' in output && output.subtype !== 'success')) {
      throw new Error('Claude Code returned no successful structured result.');
    }
    return output.structured_output;
  };
}
