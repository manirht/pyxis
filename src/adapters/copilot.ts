import type { AgentAdapter } from '../types.ts';
import { invokeProvider, parseOutput, ProviderExitError, type InvokeProvider } from './process.ts';
import { ModelOutputError } from '../output-error.ts';
import { copilotContent } from './copilot-stream.ts';

function responseContent(raw: string, nativeEmptyResponse = false): string {
  const content = copilotContent(raw, nativeEmptyResponse ? 1 : 0);
  if (!content.trim())
    throw new ModelOutputError('empty', 'GitHub Copilot returned an empty model response.', content);
  if (nativeEmptyResponse) throw new Error('GitHub Copilot returned an invalid or incomplete JSON event stream.');
  return content.trim();
}

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
    let stream: string;
    let nativeEmptyResponse = false;
    try { stream = await invoke('copilot', args, { ...call, prompt }, signal); }
    catch (error) {
      if (!(error instanceof ProviderExitError) || error.exitCode !== 1 || error.stderrTruncated ||
          error.stderr.trim() !== 'Error: The model returned an empty response, so the run produced no answer.') throw error;
      stream = error.stdout;
      nativeEmptyResponse = true;
    }
    const raw = responseContent(stream, nativeEmptyResponse);
    const fence = /^`{3}(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n`{3}$/i.exec(raw);
    const output = parseOutput(fence ? fence[1] : raw, 'GitHub Copilot');
    if (output === null || typeof output !== 'object' || Array.isArray(output)) {
      throw new ModelOutputError('schema', 'GitHub Copilot returned a response that is not a JSON object.', raw);
    }
    return output;
  };
}
