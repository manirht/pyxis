import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { copilotAdapter } from '../src/adapters/copilot.ts'
import { codexAdapter } from '../src/adapters/codex.ts'
import { runProcess } from '../src/adapters/process.ts'
import { openService } from '../src/service.ts'
import { RunStore } from '../src/store.ts'
import { pinInput } from '../src/workspace.ts'
import { executeRun } from '../src/workflow/rca.ts'
import type { AgentAdapter, AgentCall, Result, RunRecord } from '../src/types.ts'
import { exec, issue, makeFixture } from './fixture.ts'

const fixtures = JSON.parse(await readFile(new URL('./fixtures/copilot-output-errors.json', import.meta.url), 'utf8'))
const agents = { A: { adapter: 'codex', model: null }, B: { adapter: 'copilot', model: null } }
const events = (content: string, exitCode = 0) => [
  { type: 'assistant.message', data: { content, toolRequests: [] } }, { type: 'result', exitCode },
].map(event => JSON.stringify(event)).join('\n') + '\n'
const inputs = (call: AgentCall) => JSON.parse(call.prompt.split('Stage inputs:\n').at(-1)!.split('\n\n')[0]!)

async function assertPrivateDiagnostics(file: string, response: unknown) {
  if (process.platform === 'win32') {
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  } else {
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).response, response)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
}

async function setup(t: TestContext, Store: typeof RunStore = RunStore) {
  const f = await makeFixture()
  t.after(f.cleanup)
  const runsDir = join(f.root, 'runs')
  await mkdir(runsDir)
  const store = new Store(runsDir)
  const run = await store.create(await pinInput({ repo: f.repo, issue }), agents)
  const report = { hypothesis: 'PRIVATE_PEER_REPORT: seconds and milliseconds differ.', evidence: [f.evidence], gaps: [] }
  const answer = (call: AgentCall): unknown => {
    if (call.stage === 'investigate') return report
    if (call.stage === 'critique') return { assessment: 'The conversion is missing.', evidence: [], objections: [] }
    if (call.stage === 'draft' || call.stage === 'revise')
      return { cause: 'Unit mismatch.', explanation: '61 is compared directly to 60000.', evidence: [f.evidence], gaps: [] }
    const { version, digest } = inputs(call)
    return { version, digest, decision: 'approve', objections: [] }
  }
  const calls: AgentCall[] = []
  const execute = async (b: AgentAdapter, timeout = 15_000, shutdown = new AbortController().signal, a: AgentAdapter = async call => answer(call)) => {
    await executeRun(store, run, { A: a, B: async (call, signal) => { calls.push(call); return b(call, signal) } },
      join(f.root, 'worktrees'), timeout, shutdown)
    return await store.artifacts(run.id)
  }
  return { f, store, run, report, answer, calls, execute, runsDir }
}

test('a wrong citation range is retried without cancelling the independent peer or publishing rejected evidence', async t => {
  const s = await setup(t)
  const path = 'python/calcstats/finance.py'
  await mkdir(dirname(join(s.f.repo, path)), { recursive: true })
  await writeFile(join(s.f.repo, path), '\n'.repeat(67) + fixtures.wrongCitation.excerpt + '\n')
  await exec('git', ['add', '--', path], { cwd: s.f.repo })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'Add captured citation fixture'], { cwd: s.f.repo })
  const pinned = await pinInput({ repo: s.f.repo, issue })
  await s.store.change(s.run.id, r => { r.input = pinned })
  s.run.input = pinned
  s.f.evidence.commit = pinned.headSha
  const rejected = { hypothesis: 'The bracket rejects the root.', evidence: [{ ...fixtures.wrongCitation, commit: pinned.headSha, path }], gaps: [] }
  let attempts = 0
  let releasePeer!: () => void
  const peerReady = new Promise<void>(resolve => { releasePeer = resolve })
  let peerCancelled = false
  const artifacts = await s.execute(async call => {
    if (call.stage === 'investigate') {
      attempts++
      assert.ok(!call.prompt.includes('PRIVATE_PEER_REPORT'), 'retries must not reveal the peer report')
      if (attempts === 1) return rejected
      assert.match(call.prompt, /validation feedback/i)
      assert.match(call.prompt, /Citation 1/)
      assert.ok(call.prompt.includes('"startLine":65'), 'a fresh retry needs its own rejected citation to correct')
      releasePeer()
    }
    return s.answer(call)
  }, 15_000, new AbortController().signal, async (call, signal) => {
    if (call.stage === 'investigate') {
      signal.addEventListener('abort', () => { peerCancelled = true; releasePeer() }, { once: true })
      await peerReady
      signal.throwIfAborted()
    }
    return s.answer(call)
  })
  assert.equal((artifacts['result.json'] as Result).status, 'finalized')
  assert.equal(attempts, 2)
  assert.equal(peerCancelled, false)
  assert.deepEqual(artifacts['reports/B.json'], s.report)
  const metadata = artifacts['attempts/investigate/B-1.json'] as { category: string }
  assert.equal(metadata.category, 'citation')
  const file = join(s.runsDir, s.run.id, 'diagnostics/investigate/B-1.json')
  await assertPrivateDiagnostics(file, rejected)
  assert.ok(!Object.keys(artifacts).some(name => name.startsWith('diagnostics/')))
})

for (const kind of ['schema', 'malformed-json', 'prose-json', 'empty', 'native-empty'] as const) {
  test('a ' + kind + ' model response is rejected then regenerated through a fresh adapter call', async t => {
    const s = await setup(t)
    let attempts = 0
    const adapter = copilotAdapter(undefined, async (_provider, _args, call, signal) => {
      if (call.stage === 'investigate' && ++attempts === 1) {
        if (kind === 'native-empty') return await runProcess({
          executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write(process.argv[2]);process.exitCode=1', events('', 1), fixtures.emptyStderr],
          label: 'GitHub Copilot', cwd: s.f.root, input: '', signal, env: process.env,
        })
        const bad = { schema: '{"hypothesis":false}', 'malformed-json': '{"hypothesis":"sensitive-unpublished-text"',
          'prose-json': fixtures.prosePrefix + JSON.stringify(s.report), empty: '' }[kind]
        return events(bad)
      }
      return events(JSON.stringify(s.answer(call)))
    })
    const artifacts = await s.execute(adapter)
    assert.equal((artifacts['result.json'] as Result).status, 'finalized', JSON.stringify(artifacts['result.json']))
    assert.equal(attempts, 2)
    assert.equal((artifacts['attempts/investigate/B-1.json'] as { category: string }).category,
      kind.includes('empty') ? 'empty' : kind === 'schema' ? 'schema' : 'json')
    assert.ok(!JSON.stringify(artifacts).includes('sensitive-unpublished-text'))
  })
}

test('prose-prefixed ballots are regenerated against the exact same immutable proposal', async t => {
  const s = await setup(t)
  let attempts = 0
  const ballots: unknown[] = []
  const adapter = copilotAdapter(undefined, async (_provider, _args, call) => {
    const answer = JSON.stringify(s.answer(call))
    if (call.stage === 'vote') {
      ballots.push(inputs(call))
      if (++attempts === 1) return events(fixtures.prosePrefix + answer)
    }
    return events(answer)
  })
  const artifacts = await s.execute(adapter)
  assert.equal((artifacts['result.json'] as Result).status, 'finalized')
  assert.equal(attempts, 2)
  assert.deepEqual(ballots[0], ballots[1])
  assert.equal((artifacts['attempts/vote-v1/B-1.json'] as { category: string }).category, 'json')
})

for (const defect of ['empty-objection', 'inconsistent-decision'] as const) {
  for (const target of ['version', 'digest', 'correct'] as const) {
    test(`${target === 'correct' ? 'correct-target' : 'wrong-target'} ballots with ${defect} ${target === 'correct' ? 'remain retryable' : 'fail before semantic recovery'} (${target})`, async t => {
      const s = await setup(t)
      let attempts = 0
      const artifacts = await s.execute(async call => {
        const answer = s.answer(call) as Record<string, unknown>
        if (call.stage === 'vote' && ++attempts === 1) return {
          ...answer,
          ...(target === 'version' ? { version: 99 } : target === 'digest' ? { digest: '0'.repeat(64) } : {}),
          decision: 'object', objections: defect === 'empty-objection' ? ['   '] : [],
        }
        return answer
      })
      const metadata = artifacts['attempts/vote-v1/B-1.json'] as { category: string, willRetry: boolean }
      if (target === 'correct') {
        assert.equal((artifacts['result.json'] as Result).status, 'finalized')
        assert.equal(attempts, 2)
        assert.equal(metadata.category, 'schema')
        assert.equal(metadata.willRetry, true)
      } else {
        const result = artifacts['result.json'] as Result
        assert.ok(result.status === 'failed')
        assert.equal(result.stage, 'vote-v1')
        assert.match(result.error.message, /different proposal/)
        assert.equal(attempts, 1)
        assert.equal(metadata.category, 'vote-target')
        assert.equal(metadata.willRetry, false)
        assert.equal(artifacts['votes/v1/B.json'], undefined)
        assert.equal(artifacts['proposals/v2.json'], undefined)
      }
    })
  }
}

for (const nativeExit of [0, 1]) {
  test(`structured Copilot session errors are terminal with native exit ${nativeExit}`, async t => {
    const s = await setup(t)
    let attempts = 0
    const artifacts = await s.execute(copilotAdapter(undefined, async (_provider, _args, call, signal) => {
      if (++attempts !== 1) return events(JSON.stringify(s.answer(call)))
      const stream = JSON.stringify({ type: 'session.error', data: {
        errorType: 'authentication', statusCode: 401, message: 'Please sign in to continue. PRIVATE_EVENT',
      } }) + '\n' + events(nativeExit === 1 ? '' : JSON.stringify(s.answer(call)), nativeExit)
      return await runProcess({ executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write(process.argv[2]);process.exitCode=Number(process.argv[3])',
          stream, nativeExit === 1 ? fixtures.emptyStderr : '', String(nativeExit)],
        label: 'GitHub Copilot', cwd: s.f.root, input: '', signal, env: process.env })
    }))
    const result = artifacts['result.json'] as Result
    assert.ok(result.status === 'failed')
    assert.equal(attempts, 1)
    assert.match(result.error.message, /session error/)
    assert.equal(artifacts['attempts/investigate/B-1.json'], undefined)
    assert.ok(!JSON.stringify(artifacts).includes('PRIVATE_EVENT'))
  })
}

test('three rejected responses exhaust recovery while preserving the published peer report and rejection history through restart', async t => {
  let markReportPublished!: () => void
  const reportPublished = new Promise<void>(resolve => { markReportPublished = resolve })
  class ObservedStore extends RunStore {
    override async publish(id: string, name: string, value: unknown) {
      const saved = await super.publish(id, name, value)
      if (name === 'reports/A.json') markReportPublished()
      return saved
    }
  }
  const s = await setup(t, ObservedStore)
  let attempts = 0
  const raw = 'sensitive-unpublished-text: not JSON ' + 'x'.repeat(16_000)
  const artifacts = await s.execute(codexAdapter(undefined, async (_provider, _args, call) => {
    if (call.stage === 'investigate') {
      attempts++
      assert.ok(call.prompt.length < 15_000, 'only a bounded preview of a rejected response belongs in the retry prompt')
      // Exhaustion cancels the peer. First establish the durable publication that
      // this test requires to survive; adapter completion alone does not prove it.
      if (attempts === 3) await reportPublished
      return raw
    }
    return JSON.stringify(s.answer(call))
  }))
  const result = artifacts['result.json'] as Result
  assert.ok(result.status === 'failed')
  assert.equal(result.stage, 'investigate')
  assert.equal(result.error.role, 'B')
  assert.equal(attempts, 3)
  assert.match(result.error.message, /3 attempts|attempts.*exhaust/i)
  assert.deepEqual(artifacts['reports/A.json'], s.report)
  assert.equal(artifacts['reports/B.json'], undefined)
  for (let n = 1; n <= 3; n++) assert.ok(artifacts[`attempts/investigate/B-${n}.json`])
  assert.ok(!JSON.stringify(artifacts).includes('sensitive-unpublished-text'))
  const restarted = await openService({ runsDir: s.runsDir })
  try {
    assert.deepEqual(await restarted.artifacts(s.run.id), artifacts)
    await assertPrivateDiagnostics(join(s.runsDir, s.run.id, 'diagnostics/investigate/B-3.json'), raw)
  } finally { await restarted.close() }
})

test('a retry uses the original stage deadline and stops its active provider on expiry', async t => {
  const s = await setup(t)
  const signals: AbortSignal[] = []
  let began = 0
  const artifacts = await s.execute(codexAdapter(undefined, async (_provider, _args, call, signal) => {
    if (call.stage !== 'investigate') return JSON.stringify(s.answer(call))
    signals.push(signal)
    if (signals.length === 1) { began = Date.now(); await delay(900, undefined, { signal }); return 'not JSON' }
    await delay(10_000, undefined, { signal })
    throw new Error('Deadline did not stop retry')
  }), 1500)
  const result = artifacts['result.json'] as Result
  assert.ok(result.status === 'failed')
  assert.match(result.error.message, /timed out/)
  assert.equal(signals.length, 2)
  assert.equal(signals[0], signals[1])
  assert.equal(signals[1]?.aborted, true)
  assert.ok(Date.now() - began < 2500, 'retry must not reset the stage deadline')
})

test('shutdown during a retry cancels it without starting another attempt', async t => {
  const s = await setup(t)
  const shutdown = new AbortController()
  let attempts = 0
  const artifacts = await s.execute(codexAdapter(undefined, async (_provider, _args, call, signal) => {
    if (call.stage !== 'investigate') return JSON.stringify(s.answer(call))
    if (++attempts === 1) return 'not JSON'
    shutdown.abort(new Error('Service stopped during the active run'))
    await delay(10_000, undefined, { signal })
    throw new Error('Shutdown failed')
  }), 15_000, shutdown.signal)
  const result = artifacts['result.json'] as Result
  assert.ok(result.status === 'failed')
  assert.match(result.error.message, /Service stopped/)
  assert.equal(attempts, 2)
  assert.ok(artifacts['attempts/investigate/B-1.json'])
  assert.equal(artifacts['attempts/investigate/B-2.json'], undefined)
})

for (const failure of ['Check the CLI login or provider credentials.', 'The installed CLI does not support restricted sessions.', 'Storage unavailable']) {
  test('a terminal execution failure is not retried: ' + failure, async t => {
    const s = await setup(t)
    let attempts = 0
    const artifacts = await s.execute(async () => { attempts++; throw new Error(failure) })
    const result = artifacts['result.json'] as Result
    assert.ok(result.status === 'failed')
    assert.equal(result.error.message, failure)
    assert.equal(attempts, 1)
    assert.equal(artifacts['attempts/investigate/B-1.json'], undefined)
  })
}

test('an authentication error cannot be retried under the native empty-response diagnostic', async t => {
  const s = await setup(t)
  let attempts = 0
  const artifacts = await s.execute(copilotAdapter(undefined, async (_provider, _args, call, signal) => {
    if (call.stage === 'investigate' && ++attempts === 1) return await runProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write(process.argv[2]);process.exitCode=1',
        JSON.stringify({ type: 'session.error', data: { message: 'authentication failed PRIVATE_TOKEN' } }) + '\n' + events('', 1), fixtures.emptyStderr],
      label: 'GitHub Copilot', cwd: s.f.root, input: '', signal, env: process.env,
    })
    return events(JSON.stringify(s.answer(call)))
  }))
  const result = artifacts['result.json'] as Result
  assert.ok(result.status === 'failed')
  assert.equal(attempts, 1)
  assert.match(result.error.message, /session error/)
  assert.ok(!JSON.stringify(artifacts).includes('PRIVATE_TOKEN'))
})

test('a rejection publication failure stops recovery and reconciles its saved diagnostic metadata', async t => {
  class StorageFault extends RunStore {
    injected = false
    override change(id: string, update: (run: RunRecord) => void | Promise<void>) {
      return super.change(id, async run => {
        await update(run)
        if (!this.injected && run.artifacts.includes('attempts/investigate/B-1.json')) {
          this.injected = true
          throw new Error('Injected attempt manifest failure')
        }
      })
    }
  }
  const s = await setup(t, StorageFault)
  let attempts = 0
  const artifacts = await s.execute(codexAdapter(undefined, async () => { attempts++; return 'not JSON' }))
  const result = artifacts['result.json'] as Result
  assert.ok(result.status === 'failed')
  assert.match(result.error.message, /attempt manifest failure/)
  assert.equal(attempts, 1)
  assert.ok(artifacts['attempts/investigate/B-1.json'])
  assert.equal(artifacts['attempts/investigate/B-2.json'], undefined)
  await assertPrivateDiagnostics(join(s.runsDir, s.run.id, 'diagnostics/investigate/B-1.json'), 'not JSON')
})

for (const kind of ['truncated', 'nonempty-failed', 'tool-only', 'wrong-exit', 'extra-stderr'] as const) {
  test('native empty recovery rejects the ' + kind + ' execution without retrying', async t => {
    const s = await setup(t)
    let attempts = 0
    let stream = events('', 1)
    let stderr = fixtures.emptyStderr
    if (kind === 'truncated') stream = stream.split('\n')[0] + '\n'
    if (kind === 'nonempty-failed') stream = events(JSON.stringify(s.report), 1)
    if (kind === 'tool-only') stream = JSON.stringify({ type: 'assistant.message', data: { content: '', toolRequests: [{}] } }) + '\n' + JSON.stringify({ type: 'result', exitCode: 1 }) + '\n'
    if (kind === 'wrong-exit') stream = events('', 0)
    if (kind === 'extra-stderr') stderr += '\nA different native failure PRIVATE_DIAGNOSTIC'
    const artifacts = await s.execute(copilotAdapter(undefined, async (_provider, _args, _call, signal) => {
      attempts++
      return await runProcess({ executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write(process.argv[2]);process.exitCode=1', stream, stderr],
        label: 'GitHub Copilot', cwd: s.f.root, input: '', signal, env: process.env })
    }))
    assert.equal((artifacts['result.json'] as Result).status, 'failed')
    assert.equal(attempts, 1)
    assert.equal(artifacts['attempts/investigate/B-1.json'], undefined)
    assert.ok(!JSON.stringify(artifacts).includes('PRIVATE_DIAGNOSTIC'))
  })
}
