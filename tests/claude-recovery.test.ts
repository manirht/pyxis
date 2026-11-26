import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { claudeAdapter } from '../src/adapters/claude.ts'
import { ModelOutputError } from '../src/output-error.ts'
import { RunStore } from '../src/store.ts'
import { executeRun } from '../src/workflow/rca.ts'
import { shapes } from '../src/workflow/outputs.ts'
import { pinInput } from '../src/workspace.ts'
import type { AgentCall, Result } from '../src/types.ts'
import { issue, makeFixture } from './fixture.ts'

const call: AgentCall = { runId: 'fixture', role: 'A', stage: 'investigate', cwd: process.cwd(),
  prompt: 'Inspect source', schema: shapes.investigate.schema, schemaPath: shapes.investigate.path }

for (const structured of [undefined, null]) {
  test(`Claude successful result with ${structured === null ? 'null' : 'missing'} structured answer is retryable`, async () => {
    const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured })
    await assert.rejects(claudeAdapter(undefined, async () => raw)(call, new AbortController().signal), error => {
      assert.ok(error instanceof ModelOutputError)
      assert.equal(error.category, 'empty')
      assert.equal(error.retryable, true)
      return true
    })
  })
}

test('Claude malformed and unsuccessful result envelopes remain terminal', async () => {
  const bad = [null, [], {}, { type: 'result', subtype: 'success' },
    { type: 'result', subtype: 'success', is_error: true },
    { type: 'result', subtype: 'error_max_structured_output_retries', is_error: false },
    { type: 'result', subtype: 'success', is_error: 'false' },
    { type: 'assistant', subtype: 'success', is_error: false, structured_output: {} },
    { structured_output: {} }]
  for (const envelope of bad) {
    await assert.rejects(claudeAdapter(undefined, async () => JSON.stringify(envelope))(call, new AbortController().signal), error => {
      assert.ok(error instanceof Error)
      assert.ok(!(error instanceof ModelOutputError), JSON.stringify(envelope))
      return true
    })
  }
})

test('Claude completed empty output recovers through the runner without cancelling its peer', async t => {
  const fixture = await makeFixture()
  t.after(fixture.cleanup)
  const root = join(fixture.root, 'runs')
  await mkdir(root)
  const store = new RunStore(root)
  const run = await store.create(await pinInput({ repo: fixture.repo, issue }),
    { A: { adapter: 'claude', model: null }, B: { adapter: 'codex', model: null } })
  let attempts = 0
  let releasePeer!: () => void
  const peer = new Promise<void>(resolve => { releasePeer = resolve })
  let cancelled = false
  const answer = (c: AgentCall) => {
    if (c.stage === 'investigate') return { hypothesis: 'Seconds and milliseconds differ.', evidence: [fixture.evidence], gaps: [] }
    if (c.stage === 'critique') return { assessment: 'Supported by the source.', evidence: [], objections: [] }
    if (c.stage === 'draft' || c.stage === 'revise')
      return { cause: 'Unit mismatch.', explanation: 'Seconds are compared directly with milliseconds.', evidence: [fixture.evidence], gaps: [] }
    const { version, digest } = JSON.parse(c.prompt.split('Stage inputs:\n').at(-1)!)
    return { version, digest, decision: 'approve', objections: [] }
  }
  const claude = claudeAdapter(undefined, async (_provider, _args, c, signal) => {
    if (c.stage === 'investigate') {
      if (++attempts === 1) return JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
      assert.match(c.prompt, /Validation feedback/)
      releasePeer()
      signal.throwIfAborted()
    }
    return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: answer(c) })
  })
  await executeRun(store, run, { A: claude, B: async (c, signal) => {
    if (c.stage === 'investigate') {
      signal.addEventListener('abort', () => { cancelled = true; releasePeer() }, { once: true })
      await peer
      signal.throwIfAborted()
    }
    return answer(c)
  } }, join(fixture.root, 'worktrees'), 10_000, new AbortController().signal)
  const artifacts = await store.artifacts(run.id)
  assert.equal((artifacts['result.json'] as Result).status, 'finalized')
  assert.equal(attempts, 2)
  assert.equal(cancelled, false)
  assert.equal((artifacts['attempts/investigate/A-1.json'] as { category: string }).category, 'empty')
  assert.ok(artifacts['reports/B.json'])
})

test('malformed or blank Claude CLI output is terminal, not a retryable model answer', async () => {
  for (const raw of ['', '   ', 'not json', '{"type":"result"']) {
    await assert.rejects(claudeAdapter(undefined, async () => raw)(call, new AbortController().signal), error =>
      error instanceof Error && !(error instanceof ModelOutputError))
  }
})

test('wrong-target errors cannot opt into model-answer retries', () => {
  assert.equal(new ModelOutputError('vote-target', 'Wrong proposal').retryable, false)
  assert.equal(new ModelOutputError('schema', 'Bad shape').retryable, true)
})
