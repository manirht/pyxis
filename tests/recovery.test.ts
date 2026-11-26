import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openService } from '../src/service.ts'
import { digestOf, jsonBytes, RunStore } from '../src/store.ts'
import { pinInput, prepareWorkspace } from '../src/workspace.ts'
import { executeRun } from '../src/workflow/rca.ts'
import { exec, makeFixture, issue } from './fixture.ts'
import type { Adapters, Result, RunRecord } from '../src/types.ts'

const agents = { A: { adapter: 'claude', model: null }, B: { adapter: 'codex', model: null } }

test('a transient manifest failure still exposes the report already published to disk', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  class FaultStore extends RunStore {
    injected = false
    override change(id: string, update: (r: RunRecord) => void | Promise<void>) {
      return super.change(id, async run => {
        await update(run)
        if (!this.injected && run.artifacts.includes('reports/A.json')) {
          this.injected = true
          throw new Error('Simulated failure replacing the manifest')
        }
      })
    }
  }
  const store = new FaultStore(join(f.root, 'runs'))
  await mkdir(store.root)
  const run = await store.create(await pinInput({ repo: f.repo, issue }), agents)
  const report = { hypothesis: 'Mismatched units', evidence: [f.evidence], gaps: [] }
  await executeRun(store, run, {
    A: async () => report,
    B: async (_call, signal) => delay(30_000, report, { signal }),
  }, join(f.root, 'worktrees'), 15_000, new AbortController().signal)
  const artifacts = await store.artifacts(run.id)
  const result = artifacts['result.json'] as Result
  assert.ok(result.status === 'failed')
  assert.match(result.error.message, /manifest/)
  assert.deepEqual(result.artifacts, ['reports/A.json'])
  assert.deepEqual(artifacts['reports/A.json'], report)
})

test('only one service owns a store at a time, even with alternate path spellings', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const runsDir = join(f.root, 'store')
  const first = await openService({ runsDir })
  try {
    await assert.rejects(openService({ runsDir: join(runsDir, '..', 'store') }), /another RCA service/i)
  } finally { await first.close() }
  const reopened = await openService({ runsDir })
  await reopened.close()
})

test('restart reconciles a surviving report, marks its interrupted stage and removes the worktree', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const runsDir = join(f.root, 'runs')
  const tempRoot = join(f.root, 'worktrees')
  await mkdir(runsDir)
  const store = new RunStore(runsDir)
  const input = await pinInput({ repo: f.repo, issue })
  const run = await store.create(input, agents)
  await store.change(run.id, r => { r.status = 'running'; r.stage = 'investigate'; r.workspaceRoot = tempRoot; r.cleanupPending = true })
  await prepareWorkspace(input, run.id, tempRoot)
  const directory = join(runsDir, run.id, 'reports')
  await mkdir(directory)
  const report = { hypothesis: 'Seconds and milliseconds are compared directly.', evidence: [f.evidence], gaps: [] }
  await writeFile(join(directory, 'A.json'), jsonBytes(report))
  const attempts = join(runsDir, run.id, 'attempts/investigate')
  await mkdir(attempts, { recursive: true })
  const rejection = { stage: 'investigate', role: 'B', attempt: 1, category: 'json', message: 'Invalid JSON response.', willRetry: true }
  await writeFile(join(attempts, 'B-1.json'), jsonBytes(rejection))
  const diagnostics = join(runsDir, run.id, 'diagnostics/investigate')
  await mkdir(diagnostics, { recursive: true })
  await writeFile(join(diagnostics, 'B-1.json'), jsonBytes({ response: 'PRIVATE_REJECTED_CONTENT', feedback: rejection }))
  const service = await openService({ runsDir, tempRoot: join(f.root, 'new-worktrees') })
  try {
    const state = await service.get(run.id)
    assert.equal(state?.status, 'failed')
    assert.equal(state?.stage, 'investigate')
    assert.equal(state?.cleanupPending, false)
    assert.match(state?.error?.message ?? '', /interrupted/)
    const artifacts = await service.artifacts(run.id)
    assert.deepEqual(artifacts['reports/A.json'], report)
    assert.deepEqual(artifacts['attempts/investigate/B-1.json'], rejection)
    assert.deepEqual((artifacts['result.json'] as { artifacts: string[] }).artifacts, ['attempts/investigate/B-1.json', 'reports/A.json'])
    assert.ok(!JSON.stringify(artifacts).includes('PRIVATE_REJECTED_CONTENT'))
    assert.equal(JSON.parse(await readFile(join(diagnostics, 'B-1.json'), 'utf8')).response, 'PRIVATE_REJECTED_CONTENT')
    await assert.rejects(readFile(join(tempRoot, run.id, 'owner.json')), { code: 'ENOENT' })
  } finally { await service.close() }
})

test('a failed HTTP bind leaves queued jobs available for the next service start', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const runsDir = join(f.root, 'runs')
  await mkdir(runsDir)
  const store = new RunStore(runsDir)
  const run = await store.create(await pinInput({ repo: f.repo, issue }), agents)
  const occupied = createServer()
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  try {
    const address = occupied.address()
    assert.ok(address && typeof address === 'object')
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
    await assert.rejects(exec(process.execPath, [cli, 'serve', '--port', String(address.port)], {
      env: { ...process.env, RCA_RUNS_DIR: runsDir, RCA_TEMP_ROOT: join(f.root, 'worktrees'), PATH: '' },
      timeout: 15_000, windowsHide: true,
    }), /EADDRINUSE/)
    assert.equal((await store.get(run.id))?.status, 'queued')
    assert.deepEqual(await store.artifacts(run.id), {})
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
})

test('restart preserves a published terminal result even if its manifest update was interrupted', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const runsDir = join(f.root, 'runs')
  await mkdir(runsDir)
  const store = new RunStore(runsDir)
  const run = await store.create(await pinInput({ repo: f.repo, issue }), agents)
  await store.change(run.id, r => { r.status = 'running'; r.stage = 'vote-v1' })
  const proposal = { cause: 'Mismatched units', explanation: '61 is compared directly to 60000.', evidence: [f.evidence], gaps: [] }
  const digest = digestOf(jsonBytes(proposal))
  await store.publish(run.id, 'proposals/v1.json', proposal)
  for (const role of ['A', 'B']) await store.publish(run.id, 'votes/v1/' + role + '.json', {
    decision: 'approve', version: 1, digest, objections: [], role, runId: run.id })
  const result: Result = { status: 'finalized', proposal, digest, version: 1 }
  await writeFile(join(runsDir, run.id, 'result.json'), jsonBytes(result))
  const service = await openService({ runsDir })
  try {
    assert.equal((await service.get(run.id))?.status, 'finalized')
    assert.deepEqual((await service.artifacts(run.id))['result.json'], result)
    await assert.rejects(store.publish(run.id, 'proposals/v1.json', {}), /stopped/)
  } finally { await service.close() }
})

test('queued records resume, keep their resolved commit, and execute one run at a time', async t => {
  const f = await makeFixture()
  t.after(() => f.cleanup())
  const runsDir = join(f.root, 'runs')
  await mkdir(runsDir)
  const store = new RunStore(runsDir)
  const input = await pinInput({ repo: f.repo, issue })
  const first = await store.create(input, agents)
  const second = await store.create(input, agents)
  let firstCall: () => void = () => {}
  let release: () => void = () => {}
  const started = new Promise<void>(res => { firstCall = res })
  const gate = new Promise<void>(res => { release = res })
  const entered: string[] = []
  const adapter: Adapters['A'] = async call => {
    entered.push(call.runId)
    if (call.runId === first.id) { firstCall(); await gate }
    throw new Error('Fixture stop')
  }
  const service = await openService({ runsDir, tempRoot: join(f.root, 'worktrees'), adapters: { A: adapter, B: adapter } })
  try {
    await started
    assert.equal((await service.get(second.id))?.status, 'queued')
    assert.ok(entered.every(id => id === first.id))
    release()
    for (let i = 0; i < 250 && (await service.get(second.id))?.status !== 'failed'; i++) await delay(25)
    assert.equal((await service.get(second.id))?.status, 'failed')
    assert.equal((await service.get(second.id))?.input.headSha, f.head)
    assert.ok(entered.includes(second.id))
  } finally { release(); await service.close() }
})
