import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startApi } from '../src/api/server.ts'
import type { ApiService } from '../src/api/server.ts'
import type { RunInput, RunRecord } from '../src/types.ts'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const execute = promisify(execFile)

function sampleRecord(): RunRecord {
  return {
    id: 'fixture-run', input: {
      repo: resolve('.'), issue: 'The result is doubled.', headRef: 'HEAD', headSha: 'a'.repeat(40),
      baseRef: null, baseSha: null,
    },
    agents: { A: { adapter: 'claude', model: null }, B: { adapter: 'codex', model: null } },
    status: 'queued', stage: 'queued', createdAt: '', updatedAt: '', finishedAt: null,
    artifacts: [], proposalDigests: {}, error: null, cleanupError: null, cleanupPending: false,
  }
}

async function fixture(t: TestContext, overrides: Partial<ApiService> = {}) {
  const record = sampleRecord()
  const saved = { 'reports/A.json': { hypothesis: '<script>source text</script>', evidence: [], gaps: [] } }
  const submissions: RunInput[] = []
  const service: ApiService = {
    storageRoot: resolve('runs'),
    reviewers: record.agents,
    async list() { return [record] },
    async report(id) { return id === record.id ? '# Fixture report\n' : null },
    async submit(input) { submissions.push(input); return record },
    async get(id) { return id === record.id ? record : null },
    async artifacts() { return saved },
    ...overrides,
  }
  const api = await startApi(service, 0)
  t.after(api.close)
  return { origin: api.origin, port: new URL(api.origin).port, record, saved, submissions }
}

function rawPost(origin: string, parts: string[], headers: Record<string, string>) {
  return new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest(origin + '/runs', { method: 'POST', headers }, response => {
      response.resume()
      response.once('end', () => resolveStatus(response.statusCode!))
    })
    request.on('error', reject)
    for (const part of parts) request.write(part)
    request.end()
  })
}

test('a script can submit from its own working directory and retrieve status and saved artifacts', async t => {
  const api = await fixture(t)
  const issue = 'A quoted "value" & a newline\nThe second line is evidence.'
  const run = await execute(process.execPath, [cliPath, 'run', '--repo', '.', '--issue', issue, '--port', api.port], {
    cwd: tmpdir(), windowsHide: true,
  })
  assert.deepEqual(JSON.parse(run.stdout), { runId: api.record.id, status: 'queued' })
  assert.equal(run.stderr, '')
  assert.equal(api.submissions.length, 1)
  // A child can retain a Windows 8.3 path (or a POSIX alias) for its cwd.
  // Compare both spellings canonically while preserving the request assertion.
  assert.deepEqual({ ...api.submissions[0], repo: await realpath(api.submissions[0]!.repo) },
    { repo: await realpath(tmpdir()), issue })
  api.record.status = 'running'
  api.record.stage = 'investigate'
  api.record.artifacts = Object.keys(api.saved)
  const status = await fetch(api.origin + '/runs/' + api.record.id)
  assert.deepEqual(await status.json(), api.record)
  const artifacts = await fetch(api.origin + '/runs/' + api.record.id + '/artifacts')
  assert.deepEqual(await artifacts.json(), api.saved)
})

test('HTTP accepts optional refs and returns a status location', async t => {
  const { origin, submissions } = await fixture(t)
  const input = { repo: resolve('.'), issue: 'Regression', base: 'v1', head: 'my branch' }
  const res = await fetch(origin + '/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(input),
  })
  assert.equal(res.status, 202)
  assert.equal(res.headers.get('Location'), '/runs/fixture-run')
  assert.deepEqual(submissions, [input])
})

test('invalid inputs, cross-origin submissions and oversized bodies are rejected before enqueue', async t => {
  const { origin, submissions } = await fixture(t)
  const valid = { repo: resolve('.'), issue: 'test' }
  const jsonHeaders = { 'Content-Type': 'application/json' }
  for (const body of ['{', 'null', '[]', JSON.stringify({ ...valid, repo: '.' }), JSON.stringify({ ...valid, issue: '  ' }),
    JSON.stringify({ ...valid, head: 3 }), JSON.stringify({ ...valid, unexpected: 'test' })]) {
    assert.equal(await rawPost(origin, [body], jsonHeaders), 400)
  }
  assert.equal(await rawPost(origin, [JSON.stringify(valid)], { 'Content-Type': 'text/plain' }), 415)
  assert.equal(await rawPost(origin, [JSON.stringify(valid)], { ...jsonHeaders, Origin: 'https://unrelated.invalid' }), 403)
  assert.equal(await rawPost(origin, [JSON.stringify(valid)], { ...jsonHeaders, Host: 'unrelated.invalid:4317' }), 403)
  assert.equal(await rawPost(origin, ['x'.repeat(48000), 'y'.repeat(48000)], jsonHeaders), 413)
  assert.deepEqual(submissions, [])
  assert.equal((await fetch(origin + '/runs/missing/artifacts')).status, 404)
})

test('invalid repo or ref from the service reaches the CLI as an actionable error', async t => {
  const { port } = await fixture(t, { async submit() { const error = new Error('Unknown head revision.'); error.name = 'InputError'; throw error } })
  await assert.rejects(execute(process.execPath, [cliPath, 'run', '--repo', '.', '--issue', 'Example', '--port', port]), error => {
    const failure = error as Error & { stderr?: string, stdout?: string, code?: number }
    assert.equal(failure.code, 1)
    assert.equal(failure.stdout, '')
    assert.match(failure.stderr ?? '', /Unknown head revision/)
    return true
  })
})

test('the dashboard and its script and stylesheet are available on loopback', async t => {
  const { origin } = await fixture(t)
  const response = await fetch(origin + '/')
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /img-src 'self'/)
  const page = await response.text()
  assert.match(page, /<main id="main"/)
  assert.match(page, /for="run-id"/)
  assert.match(page, /id="new-run"/)
  for (const path of ['/dashboard.js', '/dashboard.css', '/favicon.svg']) {
    const asset = await fetch(origin + path)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.ok((await asset.text()).length > 0)
  }
})


test('run history and report downloads retain local-only read protections', async t => {
  const { origin, record } = await fixture(t)
  const listing = await fetch(origin + '/runs')
  assert.equal(listing.status, 200)
  assert.deepEqual(await listing.json(), { runs: [record], storageRoot: resolve('runs'), reviewers: record.agents })
  const report = await fetch(origin + '/runs/' + record.id + '/report')
  assert.equal(report.status, 200)
  assert.equal(report.headers.get('Content-Type'), 'text/markdown; charset=utf-8')
  assert.equal(report.headers.get('Content-Disposition'), 'attachment; filename="pyxis-fixture-run-report.md"')
  assert.equal(report.headers.get('Cache-Control'), 'no-store')
  assert.equal(await report.text(), '# Fixture report\n')
  assert.equal((await fetch(origin + '/runs/missing/report')).status, 404)
  for (const path of ['/runs', '/runs/' + record.id + '/report']) {
    assert.equal((await fetch(origin + path, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403)
    const invalidHost = await new Promise<number>((resolveStatus, reject) => {
      const request = httpRequest(origin + path, { headers: { Host: 'unrelated.invalid' } }, response => {
        response.resume(); response.once('end', () => resolveStatus(response.statusCode!))
      })
      request.once('error', reject); request.end()
    })
    assert.equal(invalidHost, 403)
  }
  const method = await fetch(origin + '/runs', { method: 'DELETE' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('Allow'), 'GET, POST')
  assert.equal((await fetch(origin + '/runs/' + record.id + '/report', { method: 'POST' })).status, 405)
  for (const path of ['/runs/' + record.id + '/prompts/investigate/A-1.txt',
    '/runs/' + record.id + '/diagnostics/investigate/A-1.json', '/runs/' + record.id + '/events.jsonl']) {
    assert.equal((await fetch(origin + path)).status, 404)
  }
})

test('history and report storage errors return generic messages', async t => {
  const { origin } = await fixture(t, {
    async list() { throw new Error('PRIVATE_STORAGE_DETAIL') },
    async report() { throw new Error('PRIVATE_PROMPT_DETAIL') },
  })
  for (const path of ['/runs', '/runs/fixture-run/report']) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'The local service could not complete the request.' })
  }
})
