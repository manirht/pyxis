import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startApi } from '../src/api/server.ts'
import { openService } from '../src/service.ts'
import { RunStore } from '../src/store.ts'
import { pinInput } from '../src/workspace.ts'
import type { AgentCall, RunRecord } from '../src/types.ts'
import type { RunEvent } from '../src/run-report.ts'
import { issue, makeFixture } from './fixture.ts'

const agents = { A: { adapter: 'codex', model: 'fixture-a' }, B: { adapter: 'copilot', model: 'fixture-b' } }
const eventsAt = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RunEvent)
async function terminal(service: Awaited<ReturnType<typeof openService>>, id: string) {
  for (let i = 0; i < 400; i++) {
    const run = await service.get(id)
    if (run && ['failed', 'finalized', 'unresolved'].includes(run.status) && !run.cleanupPending) return run
    await delay(20)
  }
  throw new Error('Run did not finish')
}

test('running snapshots persist full workflow prompts passed to adapters and complete call audits while accepted history stays public', async t => {
  const f = await makeFixture()
  t.after(f.cleanup)
  const runsDir = join(f.root, 'runs')
  const calls: AgentCall[] = []
  let first!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { first = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const adapter = async (call: AgentCall) => {
    calls.push(call)
    if (call.stage === 'investigate') {
      if (calls.filter(value => value.stage === 'investigate').length === 2) first()
      await gate
      return { hypothesis: 'HYPOTHESIS_' + call.role, evidence: [f.evidence], gaps: ['GAP_' + call.role] }
    }
    if (call.stage === 'critique') return { assessment: 'ASSESSMENT_' + call.role, evidence: [], objections: [] }
    if (call.stage === 'draft') return { cause: 'CAUSE', explanation: 'FINAL_EXPLANATION', evidence: [f.evidence], gaps: ['FINAL_GAP'] }
    const input = JSON.parse(call.prompt.split('Stage inputs:\n').at(-1)!)
    return { version: input.version, digest: input.digest, decision: 'approve', objections: [] }
  }
  const service = await openService({ runsDir, tempRoot: join(f.root, 'worktrees'), adapters: { A: adapter, B: adapter },
    claudeModel: 'fixture-a', codexModel: 'fixture-b', deferStart: true })
  t.after(service.close)
  const api = await startApi(service, 0)
  t.after(api.close)
  const run = await service.submit({ repo: f.repo, issue, base: f.base })
  assert.match(await readFile(join(runsDir, run.id, 'REPORT.md'), 'utf8'), /queued/)
  service.start()
  await started
  assert.equal((await service.get(run.id))?.status, 'running')
  const runningReport = await service.report(run.id)
  assert.ok(runningReport?.includes('not reached a terminal outcome'))
  assert.ok(runningReport?.includes(f.head))
  assert.ok(runningReport?.includes(f.base))
  assert.deepEqual(await service.artifacts(run.id), {})
  for (const call of calls) {
    const file = join(runsDir, run.id, 'prompts/investigate/' + call.role + '-1.txt')
    if (process.platform === 'win32') await assert.rejects(readFile(file), { code: 'ENOENT' })
    else {
      assert.equal(await readFile(file, 'utf8'), call.prompt)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal((await stat(join(runsDir, run.id, 'prompts'))).mode & 0o777, 0o700)
    }
  }
  release()
  const finished = await terminal(service, run.id)
  assert.equal(finished.status, 'finalized')
  const report = await (await fetch(api.origin + '/runs/' + run.id + '/report')).text()
  for (const text of ['HYPOTHESIS_A', 'HYPOTHESIS_B', 'GAP_A', 'GAP_B', 'ASSESSMENT_A', 'ASSESSMENT_B',
    'CAUSE', 'FINAL_EXPLANATION', 'FINAL_GAP', f.evidence.excerpt, f.head, f.base, finished.proposalDigests.v1!]) {
    assert.ok(report.includes(text), 'missing report content: ' + text)
  }
  const artifacts = await service.artifacts(run.id)
  assert.ok(Object.keys(artifacts).every(name => report.includes(name)))
  const audit = await eventsAt(join(runsDir, run.id, 'events.jsonl'))
  const starts = audit.filter(event => event.kind === 'call-started')
  const ends = audit.filter(event => event.kind === 'call-finished')
  assert.equal(starts.length, 7)
  assert.equal(ends.length, 7)
  for (const start of starts) {
    const end = ends.find(event => event.stage === start.stage && event.role === start.role && event.attempt === start.attempt)
    assert.equal(end?.status, 'validated')
    assert.equal(end?.startedAt, start.startedAt)
    assert.ok(end?.finishedAt)
    assert.ok((end?.durationMs ?? -1) >= 0)
    assert.equal(start.provider, finished.agents[start.role!].adapter)
    assert.equal(start.model, finished.agents[start.role!].model)
    assert.ok(!Object.hasOwn(start, 'prompt'))
  }
  assert.ok(audit.some(event => event.kind === 'run-state' && event.status === 'finalized'))
  assert.equal((await service.list())[0]?.id, run.id)
  assert.equal(service.storageRoot, runsDir)
  assert.deepEqual(service.reviewers, finished.agents)
  const history = await (await fetch(api.origin + '/runs')).json() as { reviewers: RunRecord['agents'] }
  assert.deepEqual(history.reviewers, finished.agents)
  // The downloadable report is rebuilt from canonical records, rather than serving a stale cache.
  await writeFile(join(runsDir, run.id, 'REPORT.md'), 'STALE_CONTENT')
  assert.equal(await service.report(run.id), report)
  assert.equal(await readFile(join(runsDir, run.id, 'REPORT.md'), 'utf8'), report)
})

test('rejected output and retry prompts stay private across terminal failure and restart', async t => {
  const f = await makeFixture()
  t.after(f.cleanup)
  const runsDir = join(f.root, 'runs')
  const store = new RunStore(runsDir)
  await mkdir(runsDir)
  const run = await store.create(await pinInput({ repo: f.repo, issue }), agents)
  let attempts = 0
  const privateText = 'PRIVATE_REJECTED_OUTPUT_NEVER_PUBLISH'
  const service = await openService({ runsDir, tempRoot: join(f.root, 'worktrees'), adapters: {
    A: async () => ({ hypothesis: 'Accepted peer report', evidence: [f.evidence], gaps: [] }),
    B: async () => { attempts++; return privateText },
  } })
  const failed = await terminal(service, run.id)
  assert.equal(failed.status, 'failed')
  assert.equal(attempts, 3)
  assert.ok(failed.error?.message.includes('3 attempts'))
  const report = await service.report(run.id)
  const artifacts = await service.artifacts(run.id)
  assert.ok(report?.includes('Accepted peer report'))
  assert.ok(report?.includes('attempts/investigate/B-3.json'))
  assert.ok(!report?.includes(privateText))
  assert.ok(!JSON.stringify(artifacts).includes(privateText))
  const privatePrompt = join(runsDir, run.id, 'prompts/investigate/B-2.txt')
  if (process.platform === 'win32') await assert.rejects(readFile(privatePrompt), { code: 'ENOENT' })
  else assert.ok((await readFile(privatePrompt, 'utf8')).includes(privateText))
  const audit = await eventsAt(join(runsDir, run.id, 'events.jsonl'))
  assert.equal(audit.filter(event => event.kind === 'call-finished' && event.role === 'B' && event.status === 'rejected').length, 3)
  assert.ok(!JSON.stringify(audit).includes(privateText))
  await service.close()
  const reopened = await openService({ runsDir })
  try {
    assert.equal((await reopened.list())[0]?.status, 'failed')
    assert.equal(await reopened.report(run.id), report)
    assert.deepEqual(await reopened.artifacts(run.id), artifacts)
    const diagnostic = join(runsDir, run.id, 'diagnostics/investigate/B-3.json')
    if (process.platform === 'win32') await assert.rejects(readFile(diagnostic), { code: 'ENOENT' })
    else assert.ok((await readFile(diagnostic, 'utf8')).includes(privateText))
  } finally { await reopened.close() }
})

test('recent history is bounded, sorted and compatible with legacy terminal records without audits', async t => {
  const f = await makeFixture()
  t.after(f.cleanup)
  const root = join(f.root, 'runs')
  await mkdir(root)
  const store = new RunStore(root)
  const template = await store.create(await pinInput({ repo: f.repo, issue }), agents)
  const records: RunRecord[] = []
  for (let i = 0; i < 102; i++) {
    const id = randomUUID()
    const run = { ...template, id, status: 'failed' as const, stage: 'investigate',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), finishedAt: '2026-01-02T00:00:00Z' }
    records.push(run)
    await mkdir(join(root, id))
    await writeFile(join(root, id, 'run.json'), JSON.stringify(run))
  }
  const listing = await store.list()
  assert.equal(listing.length, 100)
  const expected = [...records, template].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 100)
  assert.deepEqual(listing.map(run => run.id), expected.map(run => run.id))
  await mkdir(join(root, 'validation'))
  assert.equal((await store.list()).length, 100)
  const legacy = records[0]!
  const service = await openService({ runsDir: root, deferStart: true })
  try {
    const report = await service.report(legacy.id)
    assert.ok(report?.includes('Older imported runs may have no call timing audit'))
    assert.equal((await service.get(legacy.id))?.status, 'failed')
    assert.equal(await service.report('missing'), null)
  } finally { await service.close() }
})


test('full workflow prompts use the same fail-closed platform policy as raw rejection diagnostics', async t => {
  const f = await makeFixture()
  t.after(f.cleanup)
  const input = await pinInput({ repo: f.repo, issue })
  const privatePrompt = 'PRIVATE_FULL_SUBMITTED_PROMPT'
  const privateOutput = 'PRIVATE_RAW_REJECTED_RESPONSE'
  for (const platform of ['win32', 'linux'] as const) {
    const root = join(f.root, platform)
    await mkdir(root)
    const store = new RunStore(root, platform)
    const run = await store.create(input, agents)
    await store.change(run.id, value => { value.status = 'running'; value.stage = 'investigate' })
    const call = await store.startCall(run.id, { stage: 'investigate', action: 'investigate', role: 'A', attempt: 1 }, privatePrompt)
    await store.finishCall(run.id, call, 'rejected', 'json')
    await store.recordRejection(run.id, 'attempts/investigate/A-1.json', {
      stage: 'investigate', role: 'A', attempt: 1, category: 'json', message: 'Invalid JSON response.', willRetry: false,
    }, privateOutput)
    await store.publish(run.id, 'reports/B.json', { hypothesis: 'Safe accepted output', evidence: [f.evidence], gaps: [] })
    await store.finish(run.id, { status: 'failed', stage: 'investigate', error: { message: 'Fixture stopped' },
      artifacts: (await store.get(run.id))!.artifacts })
    const retain = process.platform !== 'win32' && platform !== 'win32'
    for (const file of ['prompts/investigate/A-1.txt', 'diagnostics/investigate/A-1.json']) {
      if (retain) assert.equal((await stat(join(root, run.id, file))).mode & 0o777, 0o600)
      else await assert.rejects(readFile(join(root, run.id, file)), { code: 'ENOENT' })
    }
    const publicData = JSON.stringify(await store.artifacts(run.id)) + await store.report(run.id)
    assert.ok(publicData.includes('Safe accepted output'))
    assert.ok(!publicData.includes(privatePrompt))
    assert.ok(!publicData.includes(privateOutput))
    const audit = await eventsAt(join(root, run.id, 'events.jsonl'))
    assert.equal(audit.filter(event => event.kind === 'call-finished').length, 1)
    assert.ok(!JSON.stringify(audit).includes(privatePrompt))
    assert.ok(!JSON.stringify(audit).includes(privateOutput))
  }
})
