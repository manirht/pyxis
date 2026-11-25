import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { RunStore } from '../src/store.ts'

const metadata = { stage: 'investigate', role: 'B', attempt: 1, category: 'json',
  message: 'Invalid JSON response.', willRetry: true }
const name = 'attempts/investigate/B-1.json'

async function setup(t: TestContext, platform?: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), 'rca-private-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new RunStore(root, platform)
  const run = await store.create({ repo: root, issue: 'Fixture issue', headRef: 'HEAD', headSha: 'a'.repeat(40),
    baseRef: null, baseSha: null }, { A: { adapter: 'codex', model: null }, B: { adapter: 'copilot', model: null } })
  await store.change(run.id, value => { value.status = 'running' })
  return { root, store, run, diagnostics: join(root, run.id, 'diagnostics') }
}

test('Windows policy saves safe attempt metadata without creating raw diagnostics', async t => {
  const s = await setup(t, 'win32')
  await s.store.recordRejection(s.run.id, name, metadata, 'PRIVATE_REJECTED_TEXT')
  assert.deepEqual(await s.store.artifacts(s.run.id), { [name]: metadata })
  await assert.rejects(stat(s.diagnostics), { code: 'ENOENT' })
  assert.ok(!JSON.stringify(await s.store.get(s.run.id)).includes('PRIVATE_REJECTED_TEXT'))
  const reopened = new RunStore(s.root, 'win32')
  assert.deepEqual(await reopened.artifacts(s.run.id), { [name]: metadata })
  await assert.rejects(stat(s.diagnostics), { code: 'ENOENT' })
})

test('Windows policy skips new raw content while preserving and excluding legacy diagnostics', async t => {
  const s = await setup(t, 'win32')
  await mkdir(join(s.diagnostics, 'investigate'), { recursive: true, mode: 0o777 })
  // Existing files may predate this policy. They remain local and are not erased.
  const legacy = join(s.diagnostics, 'investigate/B-2.json')
  const saved = JSON.stringify({ response: 'LEGACY_PRIVATE_REJECTED_TEXT' })
  await writeFile(legacy, saved)
  const response = { toJSON() { throw new Error('Raw rejected content was serialized') } }
  await s.store.recordRejection(s.run.id, name, metadata, response)
  await s.store.reconcile(s.run.id)
  assert.deepEqual(await s.store.artifacts(s.run.id), { [name]: metadata })
  await assert.rejects(stat(join(s.diagnostics, 'investigate/B-1.json')), { code: 'ENOENT' })
  assert.equal(await readFile(legacy, 'utf8'), saved)
})

test('the default policy follows the actual platform and retains owner-only raw diagnostics on POSIX', async t => {
  const s = await setup(t)
  const response = 'PRIVATE_REJECTED_TEXT'
  await s.store.recordRejection(s.run.id, name, metadata, response)
  const file = join(s.diagnostics, 'investigate/B-1.json')
  if (process.platform === 'win32') {
    await assert.rejects(stat(s.diagnostics), { code: 'ENOENT' })
  } else {
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { feedback: metadata, response })
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  assert.deepEqual(await s.store.artifacts(s.run.id), { [name]: metadata })
})

test('a platform override cannot enable raw persistence on a real Windows host', { skip: process.platform !== 'win32' }, async t => {
  const s = await setup(t, 'linux')
  await s.store.recordRejection(s.run.id, name, metadata, 'PRIVATE_REJECTED_TEXT')
  await assert.rejects(stat(s.diagnostics), { code: 'ENOENT' })
  assert.deepEqual(await s.store.artifacts(s.run.id), { [name]: metadata })
})
