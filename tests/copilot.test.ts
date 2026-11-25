import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { copilotAdapter } from '../src/adapters/copilot.ts'
import { prepareCopilotLaunch } from '../src/adapters/copilot-home.ts'
import { bindProvider, createAdapters, isProvider } from '../src/adapters/index.ts'
import { parseOutput, shapes } from '../src/workflow/outputs.ts'
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
    jsonl(message('{}\n{}'), completed), jsonl(message('null'), completed),
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
