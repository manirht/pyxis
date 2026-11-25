import type { AgentAdapter } from '../types.ts';
import { invokeProvider, parseOutput, type InvokeProvider } from './process.ts';

export function copilotAdapter(model?: string, invoke: InvokeProvider = invokeProvider): AgentAdapter {
  return async (call, signal) => {
    // A piped prompt selects programmatic mode. Passing -p would discard stdin.
    const args = [
      '--silent', '--stream', 'off', '--output-format', 'text', '--no-color', '--no-ask-user',
      '--available-tools', 'view,grep,glob', '--deny-tool', 'shell,write', '--disallow-temp-dir',
      '--disable-builtin-mcps', '--no-custom-instructions', '--no-auto-update',
    ];
    if (model) args.push('--model', model);
    const prompt = call.prompt + '\n\nReturn a single JSON object matching the following JSON Schema. ' +
      'Output only the JSON object.\n' + JSON.stringify(call.schema);
    const raw = (await invoke('copilot', args, { ...call, prompt }, signal)).trim();
    const fence = /^`{3}(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n`{3}$/i.exec(raw);
    const output = parseOutput(fence ? fence[1] : raw, 'GitHub Copilot');
    if (output === null || typeof output !== 'object' || Array.isArray(output)) {
      throw new Error('GitHub Copilot returned a response that is not a JSON object.');
    }
    return output;
  };
}
