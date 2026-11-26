import type { AgentAdapter } from '../types.ts';
import { invokeProvider, parseOutput, ProviderExitError, type InvokeProvider } from './process.ts';
import { CopilotStream } from './copilot-stream.ts';

export function copilotAdapter(model?: string, invoke: InvokeProvider = invokeProvider): AgentAdapter {
  return async (call, signal) => {
    // A piped prompt selects programmatic mode. Passing -p would discard stdin.
    const args = [
      '--silent', '--stream', 'off', '--output-format', 'json', '--no-color', '--no-ask-user',
      '--available-tools', 'view,grep,glob', '--deny-tool', 'shell,write', '--disallow-temp-dir',
      '--disable-builtin-mcps', '--no-custom-instructions', '--no-auto-update',
    ];
    if (model) args.push('--model', model);
    const prompt = call.prompt + '\n\nReturn a single JSON object matching the following JSON Schema. ' +
      'Output only the JSON object.\n' + JSON.stringify(call.schema);
    // JSONL preserves message bytes; text mode can wrap inside a JSON string.
    const stream = new CopilotStream();
    let buffered: string;
    let exitCode: 0 | 1 = 0;
    try { buffered = await invoke('copilot', args, { ...call, prompt }, signal, chunk => stream.write(chunk)); }
    catch (error) {
      if (!(error instanceof ProviderExitError) || error.exitCode !== 1 || error.stderrTruncated ||
          error.stderr.trim() !== 'Error: The model returned an empty response, so the run produced no answer.') throw error;
      buffered = error.stdout;
      exitCode = 1;
    }
    // Injected invokers can return buffered stdout instead of forwarding chunks.
    if (buffered) stream.write(Buffer.from(buffered, 'utf8'));
    const raw = stream.content(exitCode).trim();
    if (exitCode === 1 && raw) throw new Error('GitHub Copilot returned an invalid or incomplete JSON event stream.');
    const fence = /^`{3}(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n`{3}$/i.exec(raw);
    return parseOutput(fence ? fence[1] : raw, 'GitHub Copilot');
  };
}
