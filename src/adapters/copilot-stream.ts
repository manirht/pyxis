// Tool events can be much larger in aggregate than the model's final answer.
// Bound transport work and each JSON allocation independently, retaining only
// the latest root answer. These limits do not apply to other providers.
const maxStreamBytes = 32 * 1024 * 1024;
const maxEventBytes = 4 * 1024 * 1024;
const maxAnswerBytes = 2 * 1024 * 1024;

function invalid(): Error {
  return new Error('GitHub Copilot returned an invalid or incomplete JSON event stream.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class CopilotStream {
  private bytes = 0;
  private lineBytes = 0;
  private buffer = Buffer.alloc(64 * 1024);
  private completed = false;
  private exitCode: unknown;
  private response: { content: string; hasTools: boolean; oversized: boolean } | undefined;
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > maxStreamBytes) throw new Error('GitHub Copilot response exceeded the 32 MiB stream limit.');
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.append(chunk.subarray(start, index));
      this.readLine();
      start = index + 1;
    }
    this.append(chunk.subarray(start));
  }

  private append(fragment: Buffer): void {
    const required = this.lineBytes + fragment.length;
    if (required > maxEventBytes) throw new Error('GitHub Copilot response exceeded the 4 MiB event limit.');
    if (required > this.buffer.length) {
      const grown = Buffer.alloc(Math.min(maxEventBytes, Math.max(required, this.buffer.length * 2)));
      this.buffer.copy(grown, 0, 0, this.lineBytes);
      this.buffer = grown;
    }
    fragment.copy(this.buffer, this.lineBytes);
    this.lineBytes = required;
  }

  private readLine(): void {
    let line: string;
    try { line = this.decoder.decode(this.buffer.subarray(0, this.lineBytes)); }
    catch { throw invalid(); }
    this.lineBytes = 0;
    if (!line.trim()) return;
    if (this.completed) throw invalid();
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { throw invalid(); }
    if (!isObject(event) || typeof event.type !== 'string') throw invalid();
    if (event.type === 'session.error') throw new Error('GitHub Copilot reported a session error.');
    if (event.type === 'result') {
      if (event.outcome === 'blocked') throw invalid();
      this.completed = true;
      this.exitCode = event.exitCode;
    } else if (event.type === 'assistant.message' && event.agentId === undefined) {
      const data = event.data;
      if (!isObject(data) || typeof data.content !== 'string' ||
          (data.toolRequests !== undefined && !Array.isArray(data.toolRequests))) throw invalid();
      const hasTools = Array.isArray(data.toolRequests) && data.toolRequests.length > 0;
      const oversized = Buffer.byteLength(data.content, 'utf8') > maxAnswerBytes;
      // A subsequent root message can replace commentary that was too large.
      // Never retain either tool-request content or an oversized candidate.
      this.response = { content: hasTools || oversized ? '' : data.content, hasTools, oversized };
    }
  }

  content(expectedExitCode: 0 | 1 = 0): string {
    if (this.lineBytes) this.readLine();
    if (!this.completed || this.exitCode !== expectedExitCode || !this.response || this.response.hasTools) throw invalid();
    if (this.response.oversized) throw new Error('GitHub Copilot response exceeded the 2 MiB final answer limit.');
    return this.response.content;
  }

}
