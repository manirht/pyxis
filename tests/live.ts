// Opt-in acceptance check. Runs the installed provider CLIs and keeps the run artifacts.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { startApi } from '../src/api/server.ts'
import { openService } from '../src/service.ts'
import type { Result, RunRecord } from '../src/types.ts'
import { makeFixture, exec, issue, file } from './fixture.ts'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const fixture = await makeFixture()
try {
  const service = await openService({ runsDir: process.env.RCA_RUNS_DIR, claudeModel: process.env.RCA_CLAUDE_MODEL,
    codexModel: process.env.RCA_CODEX_MODEL, copilotModel: process.env.RCA_COPILOT_MODEL,
    stageTimeoutMs: Number(process.env.RCA_STAGE_TIMEOUT_MS ?? 180000) })
  try {
    const api = await startApi(service, 0)
    try {
      const port = new URL(api.origin).port
      const output = await exec(process.execPath, [cli, 'run', '--port', port, '--repo', '.', '--issue', issue],
        { cwd: fixture.repo, windowsHide: true })
      const { runId } = JSON.parse(output.stdout)
      console.log('Live run', runId)
      let lastStage = ''
      while (true) {
        const run: RunRecord = await (await fetch(api.origin + '/runs/' + runId)).json()
        if (run.stage !== lastStage) { lastStage = run.stage; console.log('Stage', run.stage) }
        if (!['queued', 'running'].includes(run.status) && !run.cleanupPending) {
          const artifacts = await (await fetch(api.origin + '/runs/' + runId + '/artifacts')).json()
          const result: Result = artifacts['result.json']
          assert.equal(result.status, 'finalized', JSON.stringify(result))
          assert.ok(result.proposal.evidence.some(e => e.commit === fixture.head && e.path === file && e.startLine <= 2 && e.endLine >= 2))
          assert.match(result.proposal.cause + ' ' + result.proposal.explanation, /millisecond/i)
          assert.equal(result.digest, artifacts['votes/v' + result.version + '/A.json'].digest)
          assert.equal(result.digest, artifacts['votes/v' + result.version + '/B.json'].digest)
          console.log('Finalized', result.proposal.cause)
          break
        }
        if (run.cleanupError) throw new Error(run.cleanupError)
        await delay(750)
      }
    } finally { await api.close() }
  } finally { await service.close() }
} finally { await fixture.cleanup() }
