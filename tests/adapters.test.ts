import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import { claudeAdapter } from '../src/adapters/claude.ts';
import { codexAdapter } from '../src/adapters/codex.ts';
import { ProviderExitError, runProcess } from '../src/adapters/process.ts';
import type { AgentCall } from '../src/types.ts';

const call: AgentCall = {
  runId: 'fixture', role: 'A', stage: 'investigate', cwd: resolve('source with spaces'),
  evidenceDir: resolve('additional git evidence'), schema: { type: 'object' },
  schemaPath: resolve('report schema.json'), prompt: 'inspect this change',
};
const signal = new AbortController().signal;

test('Claude limits its tools and extracts only the structured result', async () => {
  const result = await claudeAdapter('claude-test', async (provider, args, actualCall, actualSignal) => {
    assert.equal(provider, 'claude');
    assert.equal(actualCall, call);
    assert.equal(actualSignal, signal);
    assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(call.schema));
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-test');
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.equal(args[args.indexOf('--add-dir') + 1], call.cwd);
    assert.equal(args[args.indexOf('--add-dir') + 2], call.evidenceDir);
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(args.includes(flag), flag);
    }
    return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { hypothesis: 'A' } });
  })(call, signal);
  assert.deepEqual(result, { hypothesis: 'A' });
});

test('Claude rejects an error envelope, a missing result and malformed output', async () => {
  for (const raw of [
    '{"is_error":true,"structured_output":{"hypothesis":"discard"}}',
    '{"subtype":"error_max_turns","structured_output":{"hypothesis":"discard"}}',
    '{"result":"a plain-text response"}', 'private malformed provider text',
  ]) {
    await assert.rejects(claudeAdapter(undefined, async () => raw)(call, signal),
      /Claude Code returned (no successful structured result|an invalid JSON response)/);
  }
});

test('Codex uses stdin, a schema file and a read-only profile, then parses final stdout', async () => {
  const result = await codexAdapter('codex-test', async (provider, args) => {
    assert.equal(provider, 'codex');
    assert.equal(args.at(-1), '-');
    assert.equal(args.includes('--json'), false);
    assert.equal(args[args.indexOf('--output-schema') + 1], call.schemaPath);
    assert.equal(args[args.indexOf('--model') + 1], 'codex-test');
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('mcp_servers={}'));
    const permissions = args.find(arg => arg.startsWith('permissions.rca.filesystem='));
    assert.ok(permissions);
    assert.ok(permissions.includes(JSON.stringify(call.cwd) + '="read"'));
    assert.ok(permissions.includes(JSON.stringify(call.evidenceDir) + '="read"'));
    assert.ok(!permissions.includes('"write"'));
    return '{"hypothesis":"B"}\n';
  })(call, signal);
  assert.deepEqual(result, { hypothesis: 'B' });
  const eventStream = '{"type":"thread.started"}\n{"type":"turn.completed"}';
  await assert.rejects(codexAdapter(undefined, async () => eventStream)(call, signal), /invalid JSON/);
});

function runNode(code: string, options: { argv?: string[]; input?: string; signal?: AbortSignal } = {}) {
  return runProcess({
    executable: process.execPath, label: 'Fixture', cwd: process.cwd(), env: process.env,
    args: ['-e', code, '--', ...(options.argv ?? [])], input: options.input ?? '', signal: options.signal ?? signal,
  });
}

async function waitForStartedPid(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(file, 'utf8'));
      if (pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('Fixture process did not start.');
}

async function assertStopped(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return;
    }
    await delay(25);
  }
  assert.fail('Fixture descendant continued running.');
}

test('the process launcher keeps UTF-8 stdin and argv intact and drains large stderr', async () => {
  const input = "A & B\n漢字 \"quotes\"\n";
  const argumentsToPreserve = ['a $value & a path with spaces', 'a "quote"', 'C:\\path with spaces\\', '', 'b\\"c'];
  const output = await runNode(`
    process.stdin.setEncoding('utf8');
    let text = '';
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => {
      process.stderr.write('x'.repeat(512 * 1024));
      process.stdout.write(JSON.stringify([process.argv.slice(1), text]));
    });
  `, { input, argv: argumentsToPreserve });
  assert.deepEqual(JSON.parse(output), [argumentsToPreserve, input]);
});

test('process errors expose status without leaking diagnostics or prompt text', async () => {
  await assert.rejects(runNode("process.stderr.write('authentication failed KEY=secret-value'); process.exitCode=3"), {
    message: 'Fixture stopped with exit code 3. Check the CLI login or provider credentials.',
  });
  await assert.rejects(runNode("process.stdout.write('x'.repeat(2*1024*1024+1))"), /2 MiB output limit/);
  await assert.rejects(runNode("throw new Error('must not start')", { signal: AbortSignal.abort() }),
    { name: 'AbortError' });
});

test('native process exit failures carry typed status and bounded private output without serializing it', async () => {
  await assert.rejects(runNode(`
    process.stdout.write('PRIVATE-STDOUT');
    process.stderr.write('PREFIX-PRIVATE' + 'x'.repeat(16*1024) + 'PRIVATE-STDERR');
    process.exitCode = 7;
  `), error => {
    assert.ok(error instanceof ProviderExitError);
    assert.equal(error.exitCode, 7);
    assert.equal(error.stdout, 'PRIVATE-STDOUT');
    assert.ok(error.stderr.endsWith('PRIVATE-STDERR'));
    assert.ok(!error.stderr.includes('PREFIX-PRIVATE'));
    assert.ok(Buffer.byteLength(error.stderr) <= 8192);
    assert.equal(error.stderrTruncated, true);
    for (const publicText of [error.message, String(error), JSON.stringify(error), inspect(error)]) {
      assert.ok(!publicText.includes('PRIVATE-STDOUT'));
      assert.ok(!publicText.includes('PRIVATE-STDERR'));
    }
    assert.ok(!Object.keys(error).includes('stderr'));
    assert.ok(!Object.keys(error).includes('stdout'));
    return true;
  });
});

test('model or source stdout cannot classify native process failure diagnostics', async () => {
  await assert.rejects(runNode(`process.stdout.write('authentication failed, network error, usage limit reached'); process.exitCode=1;`),
    error => error instanceof ProviderExitError && error.exitCode === 1 && error.message === 'Fixture stopped with exit code 1.' && error.stderr === '' && !error.stderrTruncated);
});

test('a cancelled call exits with its spawned descendant', { timeout: 15_000 }, async t => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'rca-adapter-test-'));
  const pidFile = join(directory, 'child.pid');
  const controller = new AbortController();
  let pid: number | undefined;
  t.after(async () => {
    controller.abort();
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    if (dirname(directory) === root) await rm(directory, { force: true, recursive: true });
  });
  const grandchild = `
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const result = assert.rejects(runNode(`
    require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2]], {
      stdio: 'inherit', windowsHide: true
    });
  `, { argv: [grandchild, pidFile], signal: controller.signal }), { name: 'AbortError' });
  pid = await waitForStartedPid(pidFile);
  controller.abort();
  await result;
  await assertStopped(pid);
  pid = undefined;
});

test('the Windows job stops a descendant after its provider exits', { skip: process.platform !== 'win32' }, async () => {
  const pid = Number(await runNode(`
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore', windowsHide: true
    });
    child.unref();
    process.stdout.write(String(child.pid));
  `, { signal: AbortSignal.timeout(8000) }));
  assert.ok(pid > 0);
  try { await assertStopped(pid); }
  catch (error) { process.kill(pid, 'SIGKILL'); throw error; }
});

test('the Windows job closes when the Node service crashes', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async t => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'rca-parent-test-'));
  const pidFile = join(directory, 'child.pid');
  const processModule = new URL('../src/adapters/process.ts', import.meta.url).href;
  const provider = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const service = spawn(process.execPath, ['--input-type=module', '-e', `
    const {runProcess} = await import(process.argv[1]);
    await runProcess({
      executable:process.execPath, args:['-e',process.argv[2],'--',process.argv[3]], label:'Fixture',
      cwd:process.cwd(), env:process.env, input:'', signal:new AbortController().signal
    });
  `, '--', processModule, provider, pidFile], { windowsHide: true, stdio: 'ignore' });
  let providerPid: number | undefined;
  t.after(async () => {
    service.kill();
    if (providerPid) {
      try { process.kill(providerPid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    if (dirname(directory) === root) await rm(directory, { force: true, recursive: true });
  });
  providerPid = await waitForStartedPid(pidFile);
  assert.ok(service.kill());
  await assertStopped(providerPid);
  providerPid = undefined;
});
