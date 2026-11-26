import assert from 'node:assert/strict';
import test from 'node:test';
import { copilotAdapter } from '../src/adapters/copilot.ts';
import { runProcess, ProviderExitError, type ProcessRequest } from '../src/adapters/process.ts';
import { ModelOutputError } from '../src/output-error.ts';
import type { AgentCall } from '../src/types.ts';

const call: AgentCall = { runId: 'stream', role: 'B', stage: 'investigate', cwd: process.cwd(),
  prompt: 'Investigate.', schema: { type: 'object' }, schemaPath: 'fixture.json' };
const report = { hypothesis: '漢字 and 😀 survive chunk boundaries.', evidence: [], gaps: [] };
const message = (content = JSON.stringify(report), extra: Record<string, unknown> = {}) => ({
  type: 'assistant.message', data: { content, toolRequests: [] }, ...extra,
});
const terminal = { type: 'result', exitCode: 0 };
const jsonl = (...events: unknown[]) => events.map(value => JSON.stringify(value)).join('\n') + '\n';
const nativeEmpty = 'Error: The model returned an empty response, so the run produced no answer.';

function child(source: string, options: Partial<ProcessRequest> = {}) {
  return runProcess({ executable: process.execPath, args: ['-e', source], label: 'GitHub Copilot',
    cwd: process.cwd(), input: '', signal: AbortSignal.timeout(10_000), env: process.env,
    ...options });
}

function throughAdapter(source: string, options: Partial<ProcessRequest> = {}, streamed = true) {
  return copilotAdapter(undefined, (_provider, _args, _call, signal, onStdout) =>
    child(source, { ...options, signal, onStdout: streamed ? onStdout : undefined }))(
      call, options.signal ?? AbortSignal.timeout(10_000));
}

const streamWriter = `
  const { once } = require('node:events');
  async function write(value) { if (!process.stdout.write(value)) await once(process.stdout, 'drain'); }
  async function tools(count, size = 64 * 1024) {
    for (let index = 0; index < count; index++)
      await write(JSON.stringify({type:'tool.execution_complete', data:{content:'x'.repeat(size)}})+'\\n');
  }
`;

test('Copilot stage streaming discards 32 large tool results and preserves the final root answer', async () => {
  const output = await throughAdapter(streamWriter + `
    (async () => {
      await tools(32);
      await write(${JSON.stringify(jsonl(message(), terminal))});
    })();
  `);
  assert.deepEqual(output, report);
});

test('Copilot stage streaming validates discarded events before and after large tool output', async () => {
  for (const location of ['before', 'after']) {
    await assert.rejects(throughAdapter(streamWriter + `
      (async () => {
        if (${JSON.stringify(location)} === 'before') await write('{broken}\\n');
        await tools(32);
        if (${JSON.stringify(location)} === 'after') await write('{broken}\\n');
        await write(${JSON.stringify(jsonl(message(), terminal))});
      })();
    `), /invalid.*JSON event stream/i);
  }
});

test('Copilot stage streaming keeps terminal and outstanding-tool validation after discarded events', async () => {
  for (const ending of [
    jsonl(message(), terminal, terminal), jsonl(message(), terminal, { type: 'tool.execution_complete' }),
    jsonl(message()), jsonl(terminal), jsonl(message(), { ...terminal, exitCode: 1 }),
    jsonl(message('', { data: { content: '', toolRequests: [{}] } }), terminal),
    jsonl(message(), { type: 'session.error', data: { message: 'private-diagnostic' } }, terminal),
    jsonl(message(), terminal) + '{"type":',
  ]) {
    await assert.rejects(throughAdapter(streamWriter + `
      (async () => { await tools(32); await write(${JSON.stringify(ending)}); })();
    `), error => {
      assert.ok(error instanceof Error && !(error instanceof ModelOutputError));
      assert.match(error.message, /Copilot/);
      assert.ok(!error.message.includes('private-diagnostic'));
      return true;
    });
  }
});

test('Copilot streaming separately bounds the final answer, individual event and total wire bytes', async () => {
  await assert.rejects(throughAdapter(streamWriter + `
    (async () => {
      await write(JSON.stringify({type:'assistant.message', data:{content:'x'.repeat(2*1024*1024+1)}})+'\\n');
      await write(${JSON.stringify(jsonl(terminal))});
    })();
  `), /2 MiB final answer limit/);
  await assert.rejects(throughAdapter(streamWriter + `
    (async () => { await tools(1, 4*1024*1024+1); await write(${JSON.stringify(jsonl(message(), terminal))}); })();
  `), /4 MiB event limit/);
  await assert.rejects(throughAdapter(streamWriter + `
    (async () => { await tools(513); await write(${JSON.stringify(jsonl(message(), terminal))}); })();
  `), /32 MiB stream limit/);
});

test('Copilot accepts a bounded final answer after oversized intermediate commentary', async () => {
  const output = await throughAdapter(streamWriter + `
    (async () => {
      await write(JSON.stringify({type:'assistant.message', data:{content:'x'.repeat(2*1024*1024+1)}})+'\\n');
      await write(${JSON.stringify(jsonl(message(), terminal))});
    })();
  `);
  assert.deepEqual(output, report);
});

test('Copilot accepts answers and discarded events exactly at their separate byte limits', async () => {
  const output = await throughAdapter(streamWriter + `
    (async () => {
      const event = {type:'tool.execution_complete', data:{content:''}};
      event.data.content = 'x'.repeat(4*1024*1024 - Buffer.byteLength(JSON.stringify(event)));
      await write(JSON.stringify(event)+'\\n');
      const answer = JSON.stringify({body:'x'.repeat(2*1024*1024-11)});
      await write(JSON.stringify({type:'assistant.message',data:{content:answer}})+'\\n');
      await write(${JSON.stringify(jsonl(terminal))});
    })();
  `);
  const actual = output as {body: string};
  assert.equal(actual.body.length, 2*1024*1024-11);
  assert.ok(/^x+$/.test(actual.body));
});

test('Copilot accepts exactly the total wire limit and rejects one additional byte', async () => {
  for (const extra of [0, 1]) {
    const running = throughAdapter(streamWriter + `
      (async () => {
        const ending = ${JSON.stringify(jsonl(message(), terminal))};
        let written = 0;
        for(let index=0; index<8; index++) {
          const size = index < 7 ? 4*1024*1024 : 32*1024*1024-written-Buffer.byteLength(ending);
          const event = {type:'tool.execution_complete',data:{content:''}};
          event.data.content = 'x'.repeat(size-Buffer.byteLength(JSON.stringify(event))-1);
          await write(JSON.stringify(event)+'\\n');
          written += size;
        }
        await write(ending);
        // Keep the overflowing child alive until the launcher kills it. The
        // macOS sandbox can deny signaling a group that has already vanished.
        if (${extra}) { await write(' '); setInterval(() => {}, 1000); }
      })();
    `);
    if (extra) await assert.rejects(running, /32 MiB stream limit/);
    else assert.deepEqual(await running, report);
  }
});

test('Copilot streaming preserves multibyte UTF-8 split across writes and rejects invalid bytes anywhere', async () => {
  const valid = Buffer.from(jsonl({ type: 'tool.execution_complete', data: { content: '漢字😀' } }, message(), terminal));
  const output = await throughAdapter(streamWriter + `
    (async () => { for (const byte of Buffer.from(${JSON.stringify(valid.toString('base64'))}, 'base64')) await write(Buffer.from([byte])); })();
  `);
  assert.deepEqual(output, report);
  for (const placement of ['tool', 'answer', 'trailing']) {
    await assert.rejects(throughAdapter(streamWriter + `
      (async () => {
        await tools(32);
        if (${JSON.stringify(placement)} === 'tool') await write(Buffer.concat([Buffer.from('{"type":"tool.execution_complete","data":{"content":"'), Buffer.from([0xc3,0x28]), Buffer.from('"}}\\n')]));
        if (${JSON.stringify(placement)} === 'answer') await write(Buffer.concat([Buffer.from('{"type":"assistant.message","data":{"content":"'), Buffer.from([0xff]), Buffer.from('"}}\\n')]));
        await write(${JSON.stringify(jsonl(message(), terminal))});
        if (${JSON.stringify(placement)} === 'trailing') await write(Buffer.from([0xe2,0x82]));
      })();
    `), /invalid.*JSON event stream/i);
  }
});

test('only native Copilot stderr classifies native-empty failure, regardless of source and model text', async () => {
  const empty = jsonl({ type: 'tool.execution_complete', data: { content: 'authentication failed, usage limit reached, network error' } },
    message('The source logs authentication failed, usage limit reached, and network error.'), message(''), { type: 'result', exitCode: 1 });
  await assert.rejects(child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=1;`),
    error => error instanceof ProviderExitError && error.exitCode === 1 && error.stderr === nativeEmpty && error.stdout === empty);
  // Injected invokers may still use the plain-text process contract. Classify
  // stderr correctly there too, before the adapter validates the JSONL.
  await assert.rejects(copilotAdapter(undefined, async () => child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=1;`,
    {}))(call, AbortSignal.timeout(1000)),
    error => error instanceof ModelOutputError && error.category === 'empty');
  await assert.rejects(child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write('authentication failed PRIVATE-TOKEN'); process.exitCode=1;`),
    error => error instanceof ProviderExitError && error.exitCode === 1 && /credentials/.test(error.message) && !error.message.includes('PRIVATE-TOKEN'));
  const errorStream = jsonl(message(''), { type: 'session.error', data: { message: 'PRIVATE-TOKEN' } }, { type: 'result', exitCode: 1 });
  await assert.rejects(throughAdapter(`process.stdout.write(${JSON.stringify(errorStream)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=1;`),
    error => error instanceof Error && !(error instanceof ModelOutputError) && !error.message.includes('PRIVATE-TOKEN'));
  for (const diagnostic of ['Error: The model returned an empty response.', nativeEmpty + '\nauthentication failed', 'network error', 'usage limit reached']) {
    await assert.rejects(copilotAdapter(undefined, async () => child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode=1;`))(call, AbortSignal.timeout(1000)),
      error => error instanceof ProviderExitError);
  }
  for (const output of [jsonl(message(), { type: 'result', exitCode: 1 }), jsonl(message(''), terminal), jsonl(message(''))]) {
    await assert.rejects(copilotAdapter(undefined, async () => child(`process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=1;`))(call, AbortSignal.timeout(1000)),
      error => error instanceof Error && !(error instanceof ModelOutputError));
  }
});

test('Copilot alone interprets typed exits and validates the actual failed stream before retrying', async () => {
  const empty = jsonl(message(''), { type: 'result', exitCode: 1 });
  for (const streamed of [false, true]) {
    // A different launcher label must not change Copilot adapter semantics.
    await assert.rejects(copilotAdapter(undefined, async (_provider, _args, _call, _signal, onStdout) => child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=1;`,
      { label: 'Generic launcher', onStdout: streamed ? onStdout : undefined }))(call, AbortSignal.timeout(1000)),
      error => error instanceof ModelOutputError && error.category === 'empty');
    for (const output of [
      '', jsonl(message('')), jsonl({type:'result',exitCode:1}),
      jsonl(message(''), terminal), jsonl(message(''), {type:'result',exitCode:2}),
      jsonl(message('nonempty'), {type:'result',exitCode:1}),
      jsonl(message('', {data:{content:'',toolRequests:[{id:'pending'}]}}), {type:'result',exitCode:1}),
    ]) {
      await assert.rejects(copilotAdapter(undefined, async (_provider, _args, _call, _signal, onStdout) => child(`process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=1;`,
        { onStdout: streamed ? onStdout : undefined }))(call, AbortSignal.timeout(1000)), error => error instanceof Error && !(error instanceof ModelOutputError));
    }
  }
  await assert.rejects(copilotAdapter(undefined, async () => child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write('PRIVATE-EARLIER-DIAGNOSTIC'+' '.repeat(9000)+${JSON.stringify(nativeEmpty)}); process.exitCode=1;`))(call, AbortSignal.timeout(1000)),
    error => error instanceof ProviderExitError && error.stderrTruncated);
  await assert.rejects(copilotAdapter(undefined, async () => child(`process.stdout.write(${JSON.stringify(empty)}); process.stderr.write(${JSON.stringify(nativeEmpty)}); process.exitCode=2;`))(call, AbortSignal.timeout(1000)),
    error => error instanceof ProviderExitError && error.exitCode === 2);
});

test('streamed native failures keep status and stderr without rebuilding or retaining stdout', async () => {
  const source = streamWriter + `
    (async () => {
      await tools(32);
      await write(${JSON.stringify(jsonl(message(''), {type:'result',exitCode:1}))});
      process.stderr.write(${JSON.stringify(nativeEmpty)});
      process.exitCode = 1;
    })();
  `;
  let received = 0;
  await assert.rejects(child(source, { onStdout: chunk => { received += chunk.length; } }), error => {
    assert.ok(error instanceof ProviderExitError);
    assert.equal(error.exitCode, 1);
    assert.equal(error.stderr, nativeEmpty);
    assert.equal(error.stdout, '');
    return true;
  });
  assert.ok(received > 2 * 1024 * 1024);
  await assert.rejects(throughAdapter(source),
    error => error instanceof ModelOutputError && error.category === 'empty');
});

test('Copilot streaming keeps cancellation and deadlines effective while draining tools', async () => {
  for (const reason of [undefined, new DOMException('deadline', 'TimeoutError')]) {
    const controller = new AbortController();
    const running = throughAdapter(streamWriter + `(async () => { while(true) await tools(1); })();`, { signal: controller.signal });
    const rejected = assert.rejects(running, { name: reason ? 'TimeoutError' : 'AbortError' });
    setTimeout(() => controller.abort(reason), 30);
    await rejected;
  }
});
