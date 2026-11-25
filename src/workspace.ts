import { spawn } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import path from 'node:path'
import type { Evidence, PinnedInput, RunInput } from './types.ts'

const gitOptions = [
  '--no-pager', '--no-replace-objects', '--literal-pathspecs',
  '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
  '-c', 'core.symlinks=false', '-c', 'submodule.recurse=false',
]
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--submodule=short', '--ignore-submodules=none']

interface GitOptions {
  config?: Record<string, string>
  allowNoMatch?: boolean
  signal?: AbortSignal
}

// Returning false from consume stops a bounded preview without buffering the rest of the blob.
function readGit(cwd: string, args: string[], consume: (chunk: Buffer) => boolean, options: GitOptions = {}): Promise<void> {
  options.signal?.throwIfAborted()
  const environment: NodeJS.ProcessEnv = { ...gitEnv, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
  const config = Object.entries(options.config ?? {})
  environment.GIT_CONFIG_COUNT = String(config.length)
  config.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key
    environment[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...gitOptions, ...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let doneReading = false
    let failure: Error | undefined
    let diagnostic = ''
    const abort = () => {
      const reason = options.signal?.reason
      failure = reason instanceof Error ? reason : new Error(String(reason ?? 'Git operation aborted'))
      child.kill()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      failure = new Error(`git ${args[0]} timed out`)
      child.kill()
    }, 120_000)
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostic.length < 8192) diagnostic += chunk.toString('utf8').slice(0, 8192 - diagnostic.length)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (doneReading) return
      try {
        doneReading = !consume(chunk)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        doneReading = true
      }
      if (doneReading) child.kill()
    })
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (doneReading || code === 0 || (code === 1 && options.allowNoMatch)) resolve()
      else reject(new Error(diagnostic.trim() || `git ${args[0]} exited with code ${code}`))
    })
  })
}

async function capture(cwd: string, args: string[], limit: number, options: GitOptions = {}) {
  const chunks: Buffer[] = []
  let length = 0
  let truncated = false
  await readGit(cwd, args, chunk => {
    chunks.push(chunk.subarray(0, limit - length))
    length += chunk.length
    truncated = length > limit
    return !truncated
  }, options)
  return { bytes: Buffer.concat(chunks), truncated }
}

async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const { bytes, truncated } = await capture(cwd, args, 4 * 1024 * 1024, options)
  if (truncated) throw new Error(`git ${args[0]} output exceeded the metadata limit`)
  return bytes.toString('utf8')
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a nonempty string`)
  return value
}

async function pinRef(repo: string, ref: string): Promise<string> {
  const sha = (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
  if (!objectId.test(sha)) throw new Error(`Unable to resolve Git ref ${ref} to a commit`)
  return sha
}

export async function pinInput(input: RunInput): Promise<PinnedInput> {
  const issue = requiredString(input.issue, 'issue')
  const directory = await realpath(requiredString(input.repo, 'repo'))
  const repo = await realpath((await git(directory, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''))
  if (!within(repo, directory)) throw new Error('Input path is outside the resolved Git working tree')
  const headRef = input.head === undefined ? 'HEAD' : requiredString(input.head, 'head')
  const baseRef = input.base === undefined ? null : requiredString(input.base, 'base')
  const headSha = await pinRef(repo, headRef)
  const baseSha = baseRef === null ? null : baseRef === headRef ? headSha : await pinRef(repo, baseRef)
  return { issue, repo, headRef, headSha, baseRef, baseSha }
}

function checkRunId(runId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId)) {
    throw new Error('Invalid run ID for temporary workspace')
  }
}

function within(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

// Resolve existing ancestor symlinks before creating any directories in a user-specified temp root.
async function prospectivePath(location: string): Promise<string> {
  let ancestor = path.resolve(location)
  const missing: string[] = []
  for (;;) {
    try { return path.join(await realpath(ancestor), ...missing) }
    catch (error) {
      const parent = path.dirname(ancestor)
      if (!isMissing(error) || parent === ancestor) throw error
      missing.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}

function safePath(file: string) {
  return typeof file === 'string' && !/[\\:\u0000-\u001f\u007f]/.test(file) &&
    file.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

function checkPinned(input: PinnedInput) {
  if (!objectId.test(input.headSha) || (input.baseSha !== null && !objectId.test(input.baseSha))) {
    throw new Error('Workspace requires full pinned Git commit IDs')
  }
}

type BlobEntry = { path: string, oid: string }

function treeEntries(bytes: Buffer): BlobEntry[] {
  // The final segment can be a partial path when the tree listing hits its byte budget.
  return bytes.toString('utf8').split('\0').slice(0, -1).flatMap(record => {
    const match = /^(?:100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
    return match && safePath(match[2]) ? [{ path: match[2], oid: match[1] }] : []
  })
}

async function findBlob(repo: string, commit: string, file: string, signal?: AbortSignal): Promise<BlobEntry | undefined> {
  const listing = await capture(repo, ['ls-tree', '--full-tree', '-z', commit, '--', file], 64 * 1024, { signal })
  return treeEntries(listing.bytes).find(entry => entry.path === file)
}

async function sourcePreview(repo: string, commit: string, entry: BlobEntry, signal?: AbortSignal): Promise<string | undefined> {
  const { bytes, truncated } = await capture(repo, ['cat-file', 'blob', entry.oid], 3000, { signal })
  if (bytes.includes(0)) return
  // A cut UTF-8 character or line is never presented as an exact excerpt.
  const end = truncated ? bytes.lastIndexOf(10) + 1 : bytes.length
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end))
  } catch { return }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!lines.length && !truncated) return
  const numbered = lines.slice(0, 40).map((line, index) => `${index + 1} | ${line}`)
  if (lines.length > 40 || truncated) numbered.push('[source preview truncated]')
  return `Source at ${commit} in ${JSON.stringify(entry.path)}\n${numbered.join('\n')}`
}

async function prepareEvidence(input: PinnedInput, directory: string, signal?: AbortSignal) {
  const tree = await capture(input.repo, ['ls-tree', '-r', '--full-tree', '-z', input.headSha], 512 * 1024, { signal })
  const entries = treeEntries(tree.bytes)
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const listed: string[] = []
  let listLength = 0
  for (const entry of entries) {
    if (listed.length >= 100 || listLength + entry.path.length > 4500) break
    listed.push(entry.path)
    listLength += entry.path.length + 1
  }
  const sections = [
    `Pinned HEAD ${input.headSha}\n${input.baseSha ? `Pinned base ${input.baseSha}` : 'No base commit was supplied.'}`,
    'Source previews use a numbered margin. For evidence, copy only the exact source after " | ", preserving indentation.',
    `Tracked regular files at HEAD\n${listed.join('\n')}${tree.truncated || listed.length < entries.length ? '\n[file list truncated]' : ''}`,
  ]
  let changed: string[] = []
  let evidenceDir: string | undefined
  if (input.baseSha) {
    const range = [input.baseSha, input.headSha, '--']
    const names = await capture(input.repo, ['diff', ...diffOptions, '--name-only', '-z', ...range], 32 * 1024, { signal })
    changed = names.bytes.toString('utf8').split('\0').slice(0, -1).filter(safePath)
    evidenceDir = path.join(directory, 'evidence')
    await mkdir(evidenceDir, { mode: 0o700 })
    const patchPath = path.join(evidenceDir, 'changes.diff')
    const patch = await open(patchPath, 'wx+', 0o600)
    try {
      // Git writes the full patch directly to disk. Only the prefix enters the prompt.
      await git(input.repo, ['diff', ...diffOptions, '--binary', '--unified=2', `--output=${patchPath}`, ...range], { signal })
      const prefix = Buffer.alloc(6500)
      const { bytesRead } = await patch.read(prefix, 0, prefix.length, 0)
      const truncated = (await patch.stat()).size > bytesRead
      sections.push(`Full base-to-head diff file: ${patchPath}\nCite the original source paths, pinned commits and line numbers.\nDirect base-to-head diff\n${prefix.toString('utf8', 0, bytesRead) || '[no differences]'}${truncated ? '\n[diff truncated]' : ''}`)
    } finally {
      await patch.close()
    }
  }
  const terms = [...new Set(input.issue.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].slice(0, 64)
  const source = /\.(?:[cm]?[jt]sx?|py|rs|java|kt|scala|go|c|cc|cpp|h|cs|rb|sh|sql|toml|ya?ml|json)$/i
  const ranked = entries.map(entry => ({
    entry,
    score: (source.test(entry.path) ? 2 : 0) + (terms.some(term => entry.path.toLowerCase().includes(term)) ? 4 : 0),
  })).sort((left, right) => right.score - left.score)
  const candidates = [...new Set([...changed.slice(0, 12), ...ranked.slice(0, 24).map(item => item.entry.path)])]
  let previews = 0
  for (const file of candidates) {
    let commit = input.headSha
    let entry = byPath.get(file) ?? await findBlob(input.repo, commit, file, signal)
    if (!entry && input.baseSha) {
      commit = input.baseSha
      entry = await findBlob(input.repo, commit, file, signal)
    }
    if (!entry) continue
    const preview = await sourcePreview(input.repo, commit, entry, signal)
    if (preview) { sections.push(preview); previews++ }
    if (previews === 5) break
  }
  if (tree.truncated || entries.length > previews) sections.push('Source previews cover selected files only.')
  return { context: sections.join('\n\n'), ...(evidenceDir ? { evidenceDir } : {}) }
}

function ownerRecord(input: PinnedInput, runId: string) {
  return JSON.stringify({ owner: 'rca-harness', runId, repo: input.repo, head: input.headSha })
}

export async function prepareWorkspace(input: PinnedInput, runId: string, tempRoot: string, signal?: AbortSignal): Promise<{ cwd: string, context: string, evidenceDir?: string }> {
  signal?.throwIfAborted()
  checkRunId(runId)
  checkPinned(input)
  const root = await prospectivePath(tempRoot)
  const directory = path.join(root, runId)
  if (within(input.repo, directory) || within(directory, input.repo)) throw new Error('Temporary workspace must be outside the input repository')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (path.relative(root, await realpath(root)) !== '') throw new Error('Temporary workspace root changed during preparation')
  await mkdir(directory, { mode: 0o700 })
  const cwd = path.join(directory, 'repo')
  const ownerFile = path.join(directory, 'owner.json')
  try { await writeFile(ownerFile, ownerRecord(input, runId), { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    // Only an empty directory can be removed before the owner marker is durably available.
    await rmdir(directory).catch(() => {})
    throw error
  }
  try {
    await git(input.repo, ['worktree', 'add', '--detach', '--no-checkout', '--', cwd, input.headSha], { signal })
    // The new worktree may activate worktree-specific includes. Disable every configured external
    // content filter here, before the first checkout. Git can still apply its built-in EOL rules.
    const keys = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(process|smudge|clean|required)$'], { allowNoMatch: true, signal })
    const config = Object.fromEntries(keys.split('\0').filter(Boolean).map(key => [key, key.endsWith('.required') ? 'false' : '']))
    await git(cwd, [`--work-tree=${cwd}`, 'read-tree', '--no-sparse-checkout', '--reset', '-u', input.headSha], { config, signal })
    return { cwd, ...await prepareEvidence(input, directory, signal) }
  } catch (error) {
    try { await removeWorkspace(input, runId, tempRoot) }
    catch (cleanup) { throw new AggregateError([error, cleanup], `Workspace preparation failed: ${String(error)}. Cleanup: ${String(cleanup)}`) }
    throw error
  }
}

export async function removeWorkspace(input: PinnedInput, runId: string, tempRoot: string): Promise<void> {
  checkRunId(runId)
  let root: string
  try { root = await realpath(tempRoot) } catch (error) { if (isMissing(error)) return; throw error }
  const directory = path.join(root, runId)
  if (within(input.repo, directory) || within(directory, input.repo)) throw new Error('Unsafe workspace cleanup path')
  let stat
  try { stat = await lstat(directory) } catch (error) { if (isMissing(error)) return; throw error }
  const ownerFile = path.join(directory, 'owner.json')
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await realpath(directory)) !== '' ||
      !(await lstat(ownerFile)).isFile() || await readFile(ownerFile, 'utf8') !== ownerRecord(input, runId)) {
    throw new Error('Temporary workspace ownership could not be verified')
  }
  const cwd = path.join(directory, 'repo')
  try {
    if ((await lstat(cwd)).isSymbolicLink() || path.relative(cwd, await realpath(cwd)) !== '') throw new Error('Refusing to remove redirected worktree')
  } catch (error) { if (!isMissing(error)) throw error }
  const worktrees = await git(input.repo, ['worktree', 'list', '--porcelain', '-z'])
  if (worktrees.split('\0').some(field => field.startsWith('worktree ') && path.relative(cwd, field.slice(9)) === '')) {
    await git(input.repo, ['worktree', 'remove', '--force', '--', cwd])
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

async function matchEvidence(repo: string, oid: string, evidence: Evidence, signal?: AbortSignal) {
  const expected = evidence.excerpt.replace(/\r\n/g, '\n').split('\n')
  const count = evidence.endLine - evidence.startLine + 1
  const trailingNewline = expected.length === count + 1 && expected.at(-1) === ''
  if (trailingNewline) expected.pop()
  const mismatch = () => new Error(`Evidence does not match ${evidence.path} lines ${evidence.startLine}-${evidence.endLine}`)
  if (expected.length !== count) throw mismatch()
  const wanted = expected.map(line => Buffer.from(line))
  let number = 1
  let lineBytes = 0
  let pieces: Buffer[] = []
  let unterminated = false
  function finishLine(newline: boolean) {
    if (number >= evidence.startLine) {
      let actual = Buffer.concat(pieces, lineBytes)
      if (newline && actual.at(-1) === 13) actual = actual.subarray(0, -1)
      if (!actual.equals(wanted[number - evidence.startLine]) || (number === evidence.endLine && trailingNewline && !newline)) throw mismatch()
    }
    number++
    lineBytes = 0
    pieces = []
    unterminated = false
  }
  await readGit(repo, ['cat-file', 'blob', oid], chunk => {
    let offset = 0
    while (offset < chunk.length && number <= evidence.endLine) {
      const newline = chunk.indexOf(10, offset)
      const part = chunk.subarray(offset, newline === -1 ? chunk.length : newline)
      if (number >= evidence.startLine) {
        lineBytes += part.length
        if (lineBytes > wanted[number - evidence.startLine].length + 1 || part.includes(0)) throw mismatch()
        pieces.push(part)
      }
      unterminated = true
      if (newline === -1) break
      finishLine(true)
      offset = newline + 1
    }
    return number <= evidence.endLine
  }, { signal })
  if (unterminated) finishLine(false)
  if (number <= evidence.endLine) throw mismatch()
}

export async function validateEvidence(input: PinnedInput, evidence: Evidence[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  checkPinned(input)
  for (const item of evidence) {
    if (item.commit !== input.headSha && (!input.baseSha || item.commit !== input.baseSha)) throw new Error('Evidence must cite a pinned commit')
    if (!safePath(item.path)) throw new Error('Evidence must cite a safe repository-relative path')
    if (!Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine || typeof item.excerpt !== 'string') {
      throw new Error('Invalid evidence line range or excerpt')
    }
    const entry = await findBlob(input.repo, item.commit, item.path, signal)
    if (!entry) throw new Error(`Evidence path is not a tracked regular file: ${item.path}`)
    await matchEvidence(input.repo, entry.oid, item, signal)
  }
}
