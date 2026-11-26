import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { copilotAdapter } from '../src/adapters/copilot.ts'
import { prepareCopilotLaunch } from '../src/adapters/copilot-home.ts'
import { invokeProvider } from '../src/adapters/process.ts'
import { bindProvider, createAdapters, isProvider } from '../src/adapters/index.ts'
import { parseOutput, shapes } from '../src/workflow/outputs.ts'
import { ModelOutputError } from '../src/output-error.ts'
import type { AgentCall } from '../src/types.ts'

const call: AgentCall = {
  runId: 'fixture', role: 'B', stage: 'investigate',
  cwd: resolve('checkout with spaces'), evidenceDir: resolve('separate evidence'),
  prompt: 'Investigate a value containing literal "quotes" & a newline.\nCheck the source.',
  schema: shapes.investigate.schema, schemaPath: shapes.investigate.path,
}
const signal = new AbortController().signal
const report = { hypothesis: 'The unit conversion is missing.', evidence: [], gaps: ['Timing trace.'] }
// Copilot 1.0.115 JSONL: assistant content is an event; result carries status only.
const message = (content: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant.message', id: 'message-event', timestamp: '2026-11-25T00:00:00.000Z', parentId: 'previous-event',
  data: { messageId: 'message', originatingMessageId: 'prompt', model: 'fixture-model', providerId: 'copilot',
    content, toolRequests: [], interactionId: 'interaction', turnId: '1', rte: true, apiCallId: 'model-call' },
  ...extra,
})
const completed = { type: 'result', timestamp: '2026-11-25T00:00:01.000Z', sessionId: 'session', exitCode: 0,
  usage: { premiumRequests: 1, totalApiDurationMs: 100, sessionDurationMs: 200,
    codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n'
const response = (content = JSON.stringify(report)) => jsonl(message(content), completed)

test('Copilot sends the stage prompt and schema on stdin and limits the CLI to read-only evidence tools', async () => {
  const adapter = copilotAdapter('fixture-model', async (provider, args, actual, receivedSignal) => {
    assert.equal(provider, 'copilot')
    assert.equal(receivedSignal, signal)
    assert.equal(actual.cwd, call.cwd)
    assert.equal(actual.evidenceDir, call.evidenceDir)
    assert.ok(actual.prompt.includes(call.prompt))
    assert.ok(actual.prompt.includes(JSON.stringify(call.schema)))
    assert.ok(!args.includes(call.prompt))
    for (const option of ['--silent', '--no-ask-user', '--disable-builtin-mcps', '--no-custom-instructions', '--disallow-temp-dir']) {
      assert.ok(args.includes(option), option)
    }
    for (const option of ['--prompt', '-p', '--allow-all', '--allow-all-tools', '--allow-all-paths', '--add-dir', '--resume', '--continue']) {
      assert.ok(!args.includes(option), option)
    }
    const value = (name: string) => {
      const index = args.indexOf(name)
      assert.notEqual(index, -1, name)
      return args[index + 1]
    }
    assert.equal(value('--model'), 'fixture-model')
    assert.equal(value('--output-format'), 'json')
    assert.equal(value('--stream'), 'off')
    assert.deepEqual(value('--available-tools').split(',').sort(), ['glob', 'grep', 'view'])
    assert.deepEqual(value('--deny-tool').split(',').sort(), ['shell', 'write'])
    return response()
  })
  assert.deepEqual(parseOutput('investigate', await adapter(call, signal)), report)
})

test('Copilot accepts a single fenced JSON object and preserves the default model when no override is set', async () => {
  const adapter = copilotAdapter(undefined, async (_provider, args) => {
    assert.ok(!args.includes('--model'))
    return response('```json\n' + JSON.stringify(report) + '\n```')
  })
  assert.deepEqual(await adapter(call, signal), report)
})

test('Copilot rejects malformed, ambiguous and non-object output without publishing the raw response', async () => {
  for (const raw of ['sensitive-provider-diagnostic', 'null', '[]', 'true', 'prefix {}', '{}\n{}']) {
    const adapter = copilotAdapter(undefined, async () => raw)
    await assert.rejects(adapter(call, signal), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Copilot/i)
      assert.ok(!error.message.includes('sensitive-provider-diagnostic'))
      return true
    })
  }
})

test('Copilot reads the final root assistant event without text wrapping or tool and subagent commentary', async () => {
  const expected = { ...report, gaps: ['A long JSON string remains intact even when it exceeds a terminal width and contains an escaped newline.\nThe next line stays part of the string.'] }
  const requestedTools = { ...message('Reading the source.'), data: { content: 'Reading the source.', toolRequests: [{ toolCallId: 'read', name: 'view', arguments: { path: 'file.ts' } }] } }
  const raw = jsonl(
    { type: 'session.start', id: 'start', timestamp: '2026-11-25T00:00:00.000Z', parentId: null, data: { sessionId: 'session' } },
    message('Intermediate commentary.'), requestedTools,
    message(JSON.stringify(expected)),
    message('{"wrong":"subagent response"}', { agentId: 'child-agent' }), completed,
  )
  const adapter = copilotAdapter(undefined, async () => raw)
  assert.deepEqual(await adapter(call, signal), expected)
})

test('Copilot extracts JSON while the shared workflow validates the requested stage shape', async () => {
  for (const value of [null, [], true, 7, 'PRIVATE_INVALID_RESPONSE', {}, { wrong: 'field' }, report]) {
    const output = await copilotAdapter(undefined, async () => response(JSON.stringify(value)))(call, signal)
    assert.deepEqual(output, value)
    if (value === report) assert.deepEqual(parseOutput('investigate', output), report)
    else assert.throws(() => parseOutput('investigate', output), error =>
      error instanceof ModelOutputError && error.category === 'schema' && !error.message.includes('PRIVATE_INVALID_RESPONSE'))
  }
})

test('Copilot requires one successful terminal result and a final root response with no requested tools', async () => {
  const final = message(JSON.stringify(report))
  const toolOnly = { ...final, data: { ...final.data, toolRequests: [{ toolCallId: 'read', name: 'view', arguments: { path: 'file.ts' } }] } }
  for (const raw of [
    jsonl(final), jsonl(final) + '{"type":"result"',
    jsonl(final, { ...completed, exitCode: 1 }),
    jsonl(final, { ...completed, outcome: 'blocked' }),
    jsonl(final, completed, completed), jsonl(final, completed, final),
    jsonl(completed), jsonl(message(JSON.stringify(report), { agentId: 'child' }), completed),
    jsonl(final, toolOnly, completed), jsonl(message(''), completed),
    jsonl({ ...final, data: { content: 1 } }, completed),
    jsonl({ ...final, data: { content: '{}', toolRequests: 'view' } }, completed),
    jsonl(message('{"hypothesis":"broken\nstring"}'), completed),
    jsonl(message('{}\n{}'), completed),
    jsonl(final, null, completed), jsonl(final, { type: 1 }, completed),
  ]) {
    await assert.rejects(copilotAdapter(undefined, async () => raw)(call, signal), /Copilot/i)
  }
})

test('the registry binds Copilot independently in either role', async () => {
  assert.equal(isProvider('copilot'), true)
  assert.equal(isProvider('constructor'), false)
  assert.throws(() => bindProvider('unknown'), /Unsupported saved adapter/)
  // Cancellation before launch selects the real provider-specific path without calling a model.
  const cancelled = AbortSignal.abort()
  await assert.rejects(bindProvider('copilot')(call, cancelled), { name: 'AbortError', message: /GitHub Copilot/ })
  for (const [a, b] of [['copilot', 'codex'], ['claude', 'copilot']] as const) {
    const adapters = createAdapters({ copilotModel: 'fixture-model' }, { A: a, B: b })
    for (const [role, name] of [['A', a], ['B', b]] as const) {
      const label = { claude: /Claude Code/, codex: /Codex/, copilot: /GitHub Copilot/ }[name]
      await assert.rejects(adapters[role]({ ...call, role }, cancelled), { name: 'AbortError', message: label })
    }
  }
})

test('the private Copilot home grants only the pinned directories and excludes previous trust and secrets', async t => {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'rca-copilot-test-'))
  t.after(async () => {
    assert.equal(dirname(await realpath(root)), base)
    await rm(root, { recursive: true, force: true })
  })
  const [oldHome, scratch, checkout, evidence] = ['saved profile', 'private launch', 'repo', 'evidence'].map(part => join(root, part))
  await Promise.all([oldHome, scratch, checkout, evidence].map(dir => mkdir(dir)))
  await writeFile(join(oldHome, 'settings.json'), JSON.stringify({ hooks: 'unsafe-prior-hook' }))
  const token = 'synthetic-gh-token'
  const launch = await prepareCopilotLaunch(scratch, { cwd: checkout, evidenceDir: evidence }, { COPILOT_HOME: oldHome, GH_TOKEN: token })
  const sessionEnv: NodeJS.ProcessEnv = launch.env
  const home = launch.env.COPILOT_HOME
  assert.notEqual(home, oldHome)
  assert.notEqual(home, launch.cwd)
  assert.equal(dirname(await realpath(home)), await realpath(scratch))
  assert.equal(dirname(launch.cwd), await realpath(scratch))
  assert.equal(sessionEnv.GH_TOKEN, token)
  assert.deepEqual((await readdir(home)).sort(), ['permissions-config.json', 'settings.json'])
  const permissions = await readFile(join(home, 'permissions-config.json'), 'utf8')
  const settings = await readFile(join(home, 'settings.json'), 'utf8')
  assert.deepEqual(JSON.parse(permissions), { locations: { [launch.cwd]: { allowed_directories: await Promise.all([checkout, evidence].map(dir => realpath(dir))) } } })
  assert.equal(JSON.parse(settings).disableAllHooks, true)
  assert.ok(!settings.includes('unsafe-prior-hook'))
  assert.ok(!settings.includes(token) && !permissions.includes(token))
})

test('CLI help exposes the Copilot model setting and role config', async () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--help'], { windowsHide: true })
  assert.match(stdout, /roles\.A or roles\.B to "copilot"/)
  assert.match(stdout, /rca\.config\.json/)
  assert.match(stdout, /RCA_COPILOT_MODEL/)
})

async function bundledCopilotFixture(t: test.TestContext, version: string,
  help = '--available-tools --sync-session', output = response()) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rca-copilot-version-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const executable = join(root, 'copilot')
  const log = join(root, 'invocations.jsonl')
  async function install(actualVersion: string) {
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('--version')) process.stdout.write(${JSON.stringify(actualVersion)});
else if(args.includes('--help')) process.stdout.write(${JSON.stringify(help)});
else { process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output)})); }
`)
    await chmod(executable, 0o700)
  }
  await install(version)
  return {
    async invoke() {
      const oldPath = process.env.PATH
      process.env.PATH = root
      try {
        return await copilotAdapter(undefined, invokeProvider)({ ...call, cwd: root, evidenceDir: undefined }, AbortSignal.timeout(5000))
      } finally {
        if (oldPath === undefined) delete process.env.PATH
        else process.env.PATH = oldPath
      }
    },
    async invocations(): Promise<string[][]> { return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) },
    async replace(actualVersion: string) {
      const previous = await stat(executable)
      await install(actualVersion)
      await utimes(executable, previous.atime, new Date(previous.mtimeMs + 2000))
    },
  }
}

test('Copilot rejects old, prerelease and unrecognized bundled versions before a model call', {
  skip: process.platform === 'win32',
}, async t => {
  for (const version of [
    'GitHub Copilot CLI 1.0.94.\nRun \'copilot update\' to check for updates.\n',
    '1.0.96', '0.99.999', '1.0.97-rc.1', '1.0.115-preview.1',
    'unknown', 'error: 1.0.115 is available', '1.0.115\nprivate version diagnostic',
    '1.0.097', '9007199254740993.0.0', '',
  ]) {
    await t.test(JSON.stringify(version), async t => {
      const fixture = await bundledCopilotFixture(t, version)
      await assert.rejects(fixture.invoke(), error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /GitHub Copilot.*1\.0\.97/)
        assert.ok(!error.message.includes('private version diagnostic'))
        return true
      })
      assert.deepEqual(await fixture.invocations(), [['--no-auto-update', '--version']])
    })
  }
})

test('Copilot checks and caches bundled version and safe-session flags, then rechecks after executable changes', {
  skip: process.platform === 'win32',
}, async t => {
  for (const help of ['--available-tools --sync-session', '--available-tools --no-remote-export']) {
    await t.test(help, async t => {
      const fixture = await bundledCopilotFixture(t, "GitHub Copilot CLI 1.0.115.\nRun 'copilot update' to check for updates.\n", help)
      assert.deepEqual(await fixture.invoke(), report)
      assert.deepEqual(await fixture.invoke(), report)
      const invocations = await fixture.invocations()
      assert.deepEqual(invocations.slice(0, 2), [['--no-auto-update', '--version'], ['--no-auto-update', '--help']])
      assert.equal(invocations.length, 4)
      for (const args of invocations.slice(2)) {
        assert.ok(args.includes('--no-auto-update'))
        assert.ok(args.includes(help.includes('--sync-session') ? '--sync-session=off' : '--no-remote-export'))
      }
      await fixture.replace('1.0.94')
      await assert.rejects(fixture.invoke(), /1\.0\.97/)
      assert.deepEqual((await fixture.invocations()).at(-1), ['--no-auto-update', '--version'])
      assert.equal((await fixture.invocations()).length, 5)
    })
  }
})

test('the minimum bundled version still requires supported local-session flags and streams only stage JSONL', {
  skip: process.platform === 'win32',
}, async t => {
  for (const help of ['--available-tools', '--sync-session', '']) {
    await t.test('missing capabilities ' + JSON.stringify(help), async t => {
      const fixture = await bundledCopilotFixture(t, '1.0.97', help)
      await assert.rejects(fixture.invoke(), /restricted local sessions/)
      assert.deepEqual(await fixture.invocations(), [['--no-auto-update', '--version'], ['--no-auto-update', '--help']])
    })
  }
  const heavyOutput = jsonl(...Array.from({ length: 32 }, () => ({ type: 'tool.execution_complete', data: { content: 'x'.repeat(64 * 1024) } })), message(JSON.stringify(report)), completed)
  const fixture = await bundledCopilotFixture(t, '1.0.97', '--available-tools --sync-session', heavyOutput)
  assert.deepEqual(await fixture.invoke(), report)
})

test('bundled version parsing accepts stable future versions and distinguishes unknown banners from old versions', async () => {
  const { checkCopilotVersion } = await import('../src/adapters/process.ts')
  for (const version of ['1.0.97', '1.1.0', '2.0.0', 'v1.0.97', "GitHub Copilot CLI 1.0.115.\r\nRun 'copilot update' to check for updates.\r\n"]) {
    assert.doesNotThrow(() => checkCopilotVersion(version))
  }
  assert.throws(() => checkCopilotVersion('1.0.96'), /Update the bundled CLI/)
  for (const version of ['unknown banner', '1.0.97-preview.1', '9007199254740993.0.0']) {
    assert.throws(() => checkCopilotVersion(version), /version output was not recognized/)
  }
})
