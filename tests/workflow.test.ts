import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startApi } from '../src/api/server.ts'
import { openService } from '../src/service.ts'
import { parseOutput } from '../src/workflow/outputs.ts'
import type { AgentAdapter, AgentCall, Proposal, Report, Result, Role, RunRecord, Vote } from '../src/types.ts'
import { buggyLine, exec, file, issue, makeFixture } from './fixture.ts'

type Scenario = 'approval' | 'revision' | 'unresolved' | 'stale-vote' | 'wrong-digest' | 'bad-citation' | 'timeout'
type BallotRequest = { version: number, digest: string, proposalBytes: string }
let fixture: Awaited<ReturnType<typeof makeFixture>>
before(async () => { fixture = await makeFixture() })
after(async () => { await fixture?.cleanup() })

test('whitespace alone cannot substantiate a root cause', () => {
  assert.throws(() => parseOutput('draft', { cause: 'Claim', explanation: 'Claim explanation',
    evidence: [{ ...fixture.evidence, excerpt: '  ' }], gaps: [] }), /citation must contain source text/)
})

function stageInputs<T>(call: AgentCall): T {
  const marker = 'Stage inputs:\n'
  const start = call.prompt.lastIndexOf(marker)
  assert.ok(start >= 0, 'expected inputs for ' + call.stage)
  return JSON.parse(call.prompt.slice(start + marker.length))
}

async function waitForTerminal(service: Awaited<ReturnType<typeof openService>>, id: string) {
  const until = Date.now() + 45_000
  let run: RunRecord | null = null
  while (Date.now() < until) {
    run = await service.get(id)
    if (run && ['finalized', 'unresolved', 'failed'].includes(run.status) && !run.cleanupPending) return run
    await delay(20)
  }
  throw new Error('Did not reach a cleaned up terminal state: ' + JSON.stringify(run))
}

async function runScenario(t: TestContext, scenario: Scenario) {
  const runsDir = join(fixture.root, scenario, 'runs')
  const tempRoot = join(fixture.root, scenario, 'worktrees')
  const calls: AgentCall[] = []
  let firstRound: Vote | undefined
  const objection = 'Explain the conversion from seconds to milliseconds.'

  const adapter: AgentAdapter = async (call, signal) => {
    calls.push(call)
    if (call.stage === 'investigate') {
      if (scenario === 'approval') {
        // Each investigator waits for its peer to start. Sequential dispatch cannot pass.
        while (calls.filter(c => c.stage === 'investigate').length < 2) await delay(5, undefined, { signal })
        assert.ok(!call.prompt.includes('Stage inputs:\n'), 'both initial reports must be private')
      }
      if (scenario === 'timeout' && call.role === 'B') {
        await delay(60_000, undefined, { signal })
        throw new Error('The deadline failed to cancel the second investigator.')
      }
      const citation = scenario === 'bad-citation' && call.role === 'A'
        ? { ...fixture.evidence, excerpt: '  return true' }
        : fixture.evidence
      return { hypothesis: 'Reviewer ' + call.role + ' found a direct seconds-to-milliseconds comparison.', evidence: [citation], gaps: [] }
    }
    if (call.stage === 'critique') {
      if (scenario === 'approval') {
        const peer = call.role === 'A' ? 'B' : 'A'
        const inputs = stageInputs<{ peer: Role, report: Report }>(call)
        assert.equal(inputs.peer, peer)
        const [savedA, savedB] = await Promise.all(['A', 'B'].map(async role =>
          JSON.parse(await readFile(join(runsDir, call.runId, 'reports', role + '.json'), 'utf8')) as Report))
        assert.deepEqual(inputs.report, peer === 'A' ? savedA : savedB)
      }
      return { assessment: 'The cited line compares timestamps in different units.', evidence: [], objections: [] }
    }
    if (call.stage === 'draft' || call.stage === 'revise') {
      assert.equal(call.role, 'A', 'only the drafting role writes proposals')
      if (call.stage === 'revise') {
        const inputs = stageInputs<{ objections: string[], previousProposal: Proposal }>(call)
        assert.ok(inputs.objections.some(text => text.includes(objection)))
        assert.equal(inputs.previousProposal.explanation, '61 is compared directly with 60000.')
      }
      return {
        cause: 'The expiry comparison lost its unit conversion.',
        explanation: call.stage === 'draft' ? '61 is compared directly with 60000.' : '61 seconds equals 61000 ms, but the code tests 61 >= 60000.',
        evidence: [fixture.evidence], gaps: [],
      }
    }
    const { version, digest } = stageInputs<BallotRequest>(call)
    const vote: Vote = { decision: 'approve', version, digest, objections: [] }
    if (scenario === 'wrong-digest' && call.role === 'B') return { ...vote, digest: '0'.repeat(64) }
    if (scenario === 'stale-vote' && version === 2 && call.role === 'B') return firstRound
    if (call.role === 'B' && (scenario === 'unresolved' || (['revision', 'stale-vote'].includes(scenario) && version === 1))) {
      vote.decision = 'object'
      vote.objections = [objection]
    }
    if (call.role === 'B' && version === 1) firstRound = vote
    return vote
  }

  const service = await openService({
    runsDir, tempRoot, adapters: { A: adapter, B: adapter }, stageTimeoutMs: scenario === 'timeout' ? 2500 : 15_000,
  })
  t.after(() => service.close())
  let id: string
  if (scenario === 'approval') {
    const api = await startApi(service, 0)
    t.after(api.close)
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
    const submitted = await exec(process.execPath, [cli, 'run', '--repo', '.', '--issue', issue, '--port', new URL(api.origin).port], { cwd: fixture.repo })
    const receipt = JSON.parse(submitted.stdout)
    assert.equal(receipt.status, 'queued')
    id = receipt.runId
    const run = await waitForTerminal(service, id)
    assert.deepEqual(await (await fetch(api.origin + '/runs/' + id)).json(), run)
    assert.deepEqual(await (await fetch(api.origin + '/runs/' + id + '/artifacts')).json(), await service.artifacts(id))
  } else {
    id = (await service.submit({ repo: fixture.repo, issue, base: fixture.base })).id
  }
  const run = await waitForTerminal(service, id)
  const artifacts = await service.artifacts(id)
  const result = artifacts['result.json'] as Result
  assert.equal(result.status, run.status)
  assert.equal(run.cleanupError, null)
  await assert.rejects(access(join(tempRoot, id, 'repo')), { code: 'ENOENT' })
  assert.ok((await readFile(join(fixture.repo, file), 'utf8')).includes(buggyLine))
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: fixture.repo })).stdout.trim(), '')
  const registrations = (await exec('git', ['worktree', 'list', '--porcelain'], { cwd: fixture.repo })).stdout
  assert.equal(registrations.split(/\r?\n/).filter(line => line.startsWith('worktree ')).length, 1)
  return { run, calls, artifacts, result, runsDir, objection }
}

test('CLI issue and repo alone lead to two independent investigations and agreement on the exact saved v1', async t => {
  const { run, calls, artifacts, result, runsDir } = await runScenario(t, 'approval')
  assert.ok(result.status === 'finalized', JSON.stringify(result))
  assert.equal(result.version, 1)
  assert.equal(run.input.issue, issue)
  assert.equal(run.input.headSha, fixture.head)
  assert.equal(run.input.baseSha, null)
  assert.equal(calls.length, 7)
  assert.equal(new Set(calls.map(call => call.cwd)).size, 1)
  assert.deepEqual(Object.keys(artifacts).sort(), ['critiques/A-on-B.json', 'critiques/B-on-A.json', 'proposals/v1.json', 'reports/A.json', 'reports/B.json', 'result.json', 'votes/v1/A.json', 'votes/v1/B.json'].sort())
  const bytes = await readFile(join(runsDir, run.id, 'proposals/v1.json'), 'utf8')
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(result.digest, digest)
  assert.deepEqual(result.proposal, JSON.parse(bytes))
  assert.deepEqual(result.proposal.evidence, [fixture.evidence])
  for (const call of calls.filter(c => c.stage === 'vote')) {
    assert.deepEqual(stageInputs<BallotRequest>(call), { version: 1, digest, proposalBytes: bytes })
    assert.deepEqual(artifacts['votes/v1/' + call.role + '.json'], { runId: run.id, role: call.role, version: 1, digest, decision: 'approve', objections: [] })
  }
})

test('one objection produces v2 and both roles cast fresh votes on the revised text', async t => {
  const { run, calls, artifacts, result } = await runScenario(t, 'revision')
  assert.ok(result.status === 'finalized', JSON.stringify(result))
  assert.equal(result.version, 2)
  assert.equal(run.input.baseSha, fixture.base)
  assert.notEqual(run.proposalDigests.v1, run.proposalDigests.v2)
  assert.equal(result.digest, run.proposalDigests.v2)
  const ballots = calls.filter(call => call.stage === 'vote').map(call => call.role + stageInputs<BallotRequest>(call).version)
  assert.deepEqual(ballots.sort(), ['A1', 'A2', 'B1', 'B2'])
  assert.equal(calls.length, 10)
  assert.deepEqual(result.proposal, artifacts['proposals/v2.json'])
})

test('continued disagreement stops after v2 and preserves both final positions and the remaining objection', async t => {
  const { result, calls, objection, artifacts } = await runScenario(t, 'unresolved')
  assert.ok(result.status === 'unresolved', JSON.stringify(result))
  assert.equal(result.version, 2)
  assert.equal(result.positions.A.decision, 'approve')
  assert.equal(result.positions.B.decision, 'object')
  assert.ok(result.objections.some(text => text.includes(objection)))
  assert.equal(calls.length, 10)
  assert.equal(artifacts['proposals/v3.json'], undefined)
})

for (const scenario of ['stale-vote', 'wrong-digest'] as const) {
  test('a ' + scenario + ' response cannot approve the active proposal', async t => {
    const { run, result, artifacts, calls } = await runScenario(t, scenario)
    assert.ok(result.status === 'failed', JSON.stringify(result))
    const version = scenario === 'stale-vote' ? 2 : 1
    assert.equal(result.stage, 'vote-v' + version)
    assert.equal(result.error.role, 'B')
    assert.match(result.error.message, /different proposal/i)
    assert.equal(artifacts['votes/v' + version + '/B.json'], undefined)
    assert.equal(calls.filter(call => call.stage === 'vote' && call.role === 'B' && stageInputs<BallotRequest>(call).version === version).length, 1,
      'a wrong proposal target must fail closed without a replacement ballot')
    assert.equal((artifacts[`attempts/vote-v${version}/B-1.json`] as { willRetry: boolean }).willRetry, false)
    assert.equal(run.status, 'failed')
  })
}

test('a schema-valid citation with an incorrect excerpt fails source verification', async t => {
  const { result, artifacts } = await runScenario(t, 'bad-citation')
  assert.ok(result.status === 'failed', JSON.stringify(result))
  assert.equal(result.stage, 'investigate')
  assert.equal(result.error.role, 'A')
  assert.match(result.error.message, /evidence does not match/i)
  assert.equal(artifacts['reports/A.json'], undefined)
})

test('an investigation timeout preserves a peer report and records the failing role and stage', async t => {
  const { result, artifacts } = await runScenario(t, 'timeout')
  assert.ok(result.status === 'failed', JSON.stringify(result))
  assert.equal(result.stage, 'investigate')
  assert.equal(result.error.role, 'B')
  assert.match(result.error.message, /timed out/i)
  assert.deepEqual(result.artifacts, ['reports/A.json'])
  assert.deepEqual((artifacts['reports/A.json'] as Report).evidence, [fixture.evidence])
  assert.equal(artifacts['reports/B.json'], undefined)
})
