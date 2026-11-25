import type { AgentAdapter } from '../types.ts';
import { invokeProvider, parseOutput, ProviderExitError, type InvokeProvider } from './process.ts';
import { ModelOutputError } from '../output-error.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseContent(raw: string, nativeEmptyResponse = false): string {
  let completed = false;
  let response: { content: string; hasTools: boolean } | undefined;
  const invalid = () => new Error('GitHub Copilot returned an invalid or incomplete JSON event stream.');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (completed) throw invalid();
    const event = parseOutput(line, 'GitHub Copilot', false);
    if (!isObject(event) || typeof event.type !== 'string') throw invalid();
    if (event.type === 'result') {
      if (event.exitCode !== (nativeEmptyResponse ? 1 : 0) || event.outcome === 'blocked') throw invalid();
      completed = true;
    } else if (event.type === 'assistant.message' && event.agentId === undefined) {
      const data = event.data;
      if (!isObject(data) || typeof data.content !== 'string' ||
          (data.toolRequests !== undefined && !Array.isArray(data.toolRequests))) throw invalid();
      response = { content: data.content, hasTools: Array.isArray(data.toolRequests) && data.toolRequests.length > 0 };
    }
  }
  if (!completed || !response || response.hasTools) throw invalid();
  if (!response.content.trim())
    throw new ModelOutputError('empty', 'GitHub Copilot returned an empty model response.', response.content);
  if (nativeEmptyResponse) throw invalid();
  return response.content.trim();
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
      if (!(error instanceof ProviderExitError) || !error.emptyModelResponse) throw error;
      stream = error.output;
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
