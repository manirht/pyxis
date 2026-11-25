import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { pinInput, prepareWorkspace, removeWorkspace, validateEvidence } from '../src/workspace.ts'
import type { Evidence } from '../src/types.ts'

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', ['-c', 'user.name=Workspace Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, windowsHide: true })).stdout.trim()
}

async function fixture(t: TestContext) {
  const temp = await realpath(tmpdir())
  const home = await mkdtemp(path.join(temp, 'rca-workspace-test-'))
  t.after(async () => {
    assert.equal(path.dirname(await realpath(home)), temp)
    assert.ok(path.basename(home).startsWith('rca-workspace-test-'))
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const repo = path.join(home, 'source repository')
  const tempRoot = path.join(home, 'workspace root')
  const file = 'src/[parser].ts'
  await mkdir(path.join(repo, 'src'), { recursive: true })
  await git(repo, 'init', '--quiet')
  await git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(path.join(repo, file), 'function read() {\r\n  return 1\r\n}\r\n')
  await writeFile(path.join(repo, '.gitattributes'), '*.ts -text filter=fixture\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'base')
  const base = await git(repo, 'rev-parse', 'HEAD')
  await writeFile(path.join(repo, file), 'function read() {\r\n  return 2\r\n}\r\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'head')
  const head = await git(repo, 'rev-parse', 'HEAD')
  return { repo, tempRoot, file, base, head, home }
}

test('pins the caller’s refs once and prepares a detached worktree with bounded, numbered source', async t => {
  const { repo, tempRoot, file, base, head } = await fixture(t)
  const input = await pinInput({ repo: path.join(repo, 'src'), base: 'HEAD~1', issue: 'Parser returns the wrong number' })
  assert.equal(input.repo, await realpath(repo))
  assert.equal(input.headRef, 'HEAD')
  assert.equal(input.headSha, head)
  assert.equal(input.baseSha, base)
  await writeFile(path.join(repo, file), 'newer branch contents\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'branch moves after submission')
  const prepared = await prepareWorkspace(input, 'example-1', tempRoot)
  assert.equal(await git(prepared.cwd, 'rev-parse', 'HEAD'), head)
  assert.equal(await git(prepared.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD')
  assert.equal(await readFile(path.join(prepared.cwd, file), 'utf8'), 'function read() {\r\n  return 2\r\n}\r\n')
  assert.ok(prepared.context.includes(head) && prepared.context.includes(base))
  assert.ok(prepared.context.includes('2 |   return 2'))
  assert.ok(prepared.context.includes('-  return 1'))
  const citation: Evidence = { commit: head, path: file, startLine: 1, endLine: 2, excerpt: 'function read() {\r\n  return 2' }
  await validateEvidence(input, [citation, { ...citation, commit: base, excerpt: 'function read() {\n  return 1\n' }])
  await removeWorkspace(input, 'example-1', tempRoot)
  await removeWorkspace(input, 'example-1', tempRoot)
  await assert.rejects(lstat(prepared.cwd), { code: 'ENOENT' })
  assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1)
  assert.equal(await readFile(path.join(repo, file), 'utf8'), 'newer branch contents\n')
})

test('verifies exact lines and regular files from the pinned tree only', async t => {
  const { repo, file, base, head } = await fixture(t)
  const input = await pinInput({ repo, issue: 'Parser result' })
  assert.equal(input.baseSha, null)
  assert.equal(input.baseRef, null)
  const evidence: Evidence = { commit: head, path: file, startLine: 2, endLine: 2, excerpt: '  return 2' }
  await validateEvidence(input, [evidence])
  for (const invalid of [
    { commit: base }, { excerpt: 'return 2' }, { startLine: 0 }, { endLine: 1 }, { startLine: 4, endLine: 4, excerpt: '' },
    { path: '../outside' }, { path: 'src/../src/[parser].ts' }, { path: '/tmp/x' }, { path: 'C:\\secret' },
    { path: '.git/config' }, { path: 'src' }, { path: 'src/*.ts' }, { path: ':(glob)*' },
  ]) await assert.rejects(validateEvidence(input, [{ ...evidence, ...invalid }]))
  await assert.rejects(pinInput({ repo, head: '--help', issue: 'Bad ref' }))
  await assert.rejects(pinInput({ repo, issue: ' ' }))
})

test('a base comparison exposes the full safe diff even when the prompt preview is truncated', async t => {
  const { repo, tempRoot, file } = await fixture(t)
  const late = 'return explainFailureAtTheEnd()'
  const lines = Array.from({ length: 2100 }, (_, i) => `const example${i} = ${i}`)
  await writeFile(path.join(repo, file), [...lines, late, ''].join('\n'))
  await writeFile(path.join(repo, '.gitattributes'), '*.ts -text diff=fixture\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'large change')
  await git(repo, 'config', 'diff.fixture.textconv', 'program-that-must-never-run')
  await git(repo, 'config', 'diff.external', 'program-that-must-never-run')
  const input = await pinInput({ repo, issue: 'Investigate the parser change', base: 'HEAD~1' })
  const prepared = await prepareWorkspace(input, 'long-diff', tempRoot)
  assert.equal(prepared.evidenceDir, path.join(path.dirname(prepared.cwd), 'evidence'))
  const patchPath = path.join(prepared.evidenceDir!, 'changes.diff')
  assert.ok(prepared.context.includes(patchPath))
  assert.ok(prepared.context.includes('[diff truncated]'))
  assert.ok(!prepared.context.includes(late))
  const actual = await readFile(patchPath, 'utf8')
  assert.ok(actual.endsWith(`+${late}\n`))
  const expected = await exec('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--binary', '--unified=2', input.baseSha!, input.headSha, '--'], { cwd: repo })
  assert.equal(actual, expected.stdout)
  await removeWorkspace(input, 'long-diff', tempRoot)
  await assert.rejects(lstat(patchPath), { code: 'ENOENT' })
})

test('setup suppresses repository hooks and external filters; source previews disclose truncation', async t => {
  const { repo, tempRoot, file } = await fixture(t)
  await writeFile(path.join(repo, file), Array.from({ length: 700 }, (_, i) => `line ${i + 1}`).join('\n'))
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'long source')
  const hooks = path.join(repo, 'local hooks')
  await mkdir(hooks)
  await writeFile(path.join(hooks, 'post-checkout'), '#!/bin/sh\ntouch hook-was-run\n')
  await chmod(path.join(hooks, 'post-checkout'), 0o755)
  await writeFile(path.join(hooks, 'reference-transaction'), '#!/bin/sh\nexit 93\n')
  await chmod(path.join(hooks, 'reference-transaction'), 0o755)
  await git(repo, 'config', 'core.hooksPath', hooks)
  await git(repo, 'config', 'filter.fixture.smudge', 'printf tampered')
  await git(repo, 'config', 'filter.fixture.required', 'true')
  const input = await pinInput({ repo, issue: 'Inspect parser' })
  const prepared = await prepareWorkspace(input, 'readonly-check', tempRoot)
  assert.equal(prepared.evidenceDir, undefined)
  assert.ok(prepared.context.includes('[source preview truncated]'))
  assert.ok(prepared.context.includes('No base commit was supplied.'))
  await assert.rejects(lstat(path.join(prepared.cwd, 'hook-was-run')), { code: 'ENOENT' })
  assert.ok((await readFile(path.join(prepared.cwd, file), 'utf8')).startsWith('line 1\nline 2\n'))
  await validateEvidence(input, [{ commit: input.headSha, path: file, startLine: 700, endLine: 700, excerpt: 'line 700' }])
  await removeWorkspace(input, 'readonly-check', tempRoot)
})

test('cleanup refuses unrelated or redirected directories, and duplicate preparation preserves the active workspace', async t => {
  const { repo, home, tempRoot } = await fixture(t)
  const input = await pinInput({ repo, issue: 'Inspect parser' })
  await assert.rejects(prepareWorkspace(input, '../escape', tempRoot))
  const nested = path.join(repo, 'do not create')
  await assert.rejects(prepareWorkspace(input, 'nested', nested))
  await assert.rejects(lstat(nested), { code: 'ENOENT' })
  await mkdir(path.join(tempRoot, 'unrelated'), { recursive: true })
  const marker = path.join(tempRoot, 'unrelated', 'keep')
  await writeFile(marker, 'keep')
  await assert.rejects(removeWorkspace(input, 'unrelated', tempRoot))
  assert.equal(await readFile(marker, 'utf8'), 'keep')
  const other = path.join(home, 'redirect target')
  await mkdir(other)
  await symlink(other, path.join(tempRoot, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(removeWorkspace(input, 'redirect', tempRoot))
  assert.ok((await lstat(other)).isDirectory())
  const prepared = await prepareWorkspace(input, 'busy', tempRoot)
  await assert.rejects(prepareWorkspace(input, 'busy', tempRoot), { code: 'EEXIST' })
  assert.equal(await git(prepared.cwd, 'rev-parse', 'HEAD'), input.headSha)
  await removeWorkspace(input, 'busy', tempRoot)
})

test('a tracked symbolic link is inert in the checkout and cannot be cited as a source file', async t => {
  const { repo, tempRoot, home } = await fixture(t)
  const text = path.join(home, 'link-content')
  await writeFile(text, '../../outside')
  const blob = await git(repo, 'hash-object', '-w', '--', text)
  await git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},outside-link`)
  await git(repo, 'commit', '-qm', 'commit a symbolic link')
  const input = await pinInput({ repo, issue: 'Inspect links' })
  const prepared = await prepareWorkspace(input, 'link', tempRoot)
  const link = path.join(prepared.cwd, 'outside-link')
  assert.ok((await lstat(link)).isFile())
  assert.equal(await readFile(link, 'utf8'), '../../outside')
  await assert.rejects(validateEvidence(input, [{ commit: input.headSha, path: 'outside-link', startLine: 1, endLine: 1, excerpt: '../../outside' }]), /regular file/)
  await removeWorkspace(input, 'link', tempRoot)
})

test('supports aborted calls and cleanup of a previously removed checkout', async t => {
  const { repo, tempRoot } = await fixture(t)
  const input = await pinInput({ repo, issue: 'Inspect parser' })
  const signal = AbortSignal.abort(new Error('stage deadline'))
  await assert.rejects(prepareWorkspace(input, 'cancelled', tempRoot, signal), /stage deadline/)
  await assert.rejects(validateEvidence(input, [], signal), /stage deadline/)
  const stop = new AbortController()
  const interrupted = prepareWorkspace(input, 'interrupted', tempRoot, stop.signal)
  // The marker is written before Git starts. Wait for it so cancellation exercises owned cleanup.
  const marker = path.join(tempRoot, 'interrupted', 'owner.json')
  for (let i = 0; i < 100; i++) {
    if (await lstat(marker).then(() => true, () => false)) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok((await lstat(marker)).isFile())
  stop.abort(new Error('stop preparation'))
  await assert.rejects(interrupted, /stop preparation/)
  await assert.rejects(lstat(path.join(tempRoot, 'interrupted')), { code: 'ENOENT' })
  const prepared = await prepareWorkspace(input, 'gone', tempRoot)
  assert.equal(await realpath(prepared.cwd), path.join(await realpath(tempRoot), 'gone', 'repo'))
  await rm(prepared.cwd, { recursive: true, force: true })
  await removeWorkspace(input, 'gone', tempRoot)
  assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1)
})
