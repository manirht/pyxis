import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PinnedInput, Result, RunRecord } from './types.ts'

const roles = ['A', 'B']
const attemptArtifacts = ['investigate', 'critique', 'draft', 'revise', 'vote-v1', 'vote-v2']
  .flatMap(stage => roles.flatMap(role => [1, 2, 3].map(attempt => `attempts/${stage}/${role}-${attempt}.json`)))
const knownArtifacts = [
  ...attemptArtifacts,
  ...roles.map(role => `reports/${role}.json`),
  'critiques/A-on-B.json', 'critiques/B-on-A.json',
  ...[1, 2].flatMap(v => [`proposals/v${v}.json`, ...roles.map(role => `votes/v${v}/${role}.json`)]),
  'result.json',
]
export const isRunId = (id: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
export const jsonBytes = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
export const digestOf = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T }
  catch (e) { if (isMissing(e)) return null; throw e }
}

async function atomicWrite(file: string, bytes: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() }
    finally { await handle.close() }
    // Windows may briefly deny a replace while a poller has the old manifest open.
    // Keep the complete temp file and retry the atomic operation without unlinking the old file.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? ''
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= 7) throw e
        await delay(8 * 2 ** attempt)
      }
    }
  } finally { await rm(temporary, { force: true }) }
}

// One worker per storage root, including when two services choose different HTTP ports.
// Named pipes on Windows and abstract sockets on Linux are released by the OS on exit.
export async function claimStore(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  let canonical = await realpath(root)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const name = 'rca-harness-' + digestOf(canonical).slice(0, 24)
  const pathname = process.platform === 'win32' ? '\\\\.\\pipe\\' + name :
    process.platform === 'linux' ? '\0' + name : join(tmpdir(), name + '.sock')
  const server = createServer(socket => socket.destroy())
  const listen = () => new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onReady); reject(e) }
    const onReady = () => { server.off('error', onError); resolve() }
    server.once('error', onError).once('listening', onReady).listen(pathname)
  })
  try { await listen() }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
    if (process.platform === 'win32' || process.platform === 'linux') throw new Error('Another RCA service owns this run directory')
    const stale = await new Promise<boolean>(resolve => {
      const socket = createConnection(pathname)
      socket.once('connect', () => { socket.destroy(); resolve(false) })
      socket.once('error', err => resolve((err as NodeJS.ErrnoException).code === 'ECONNREFUSED'))
    })
    if (!stale) throw new Error('Another RCA service owns this run directory')
    await rm(pathname, { force: true })
    await listen()
  }
  server.unref()
  return () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
}

export class RunStore {
  root: string
  private tail: Promise<unknown> = Promise.resolve()
  constructor(root: string) { this.root = root }

  private directory(id: string) {
    if (!isRunId(id)) throw new Error('Invalid run ID')
    return join(this.root, id)
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => {})
    return next
  }

  async create(input: PinnedInput, agents: RunRecord['agents']): Promise<RunRecord> {
    const id = randomUUID()
    const now = new Date().toISOString()
    const run: RunRecord = { id, input, agents, status: 'queued', stage: 'queued', createdAt: now,
      updatedAt: now, finishedAt: null, artifacts: [], proposalDigests: {}, error: null,
      cleanupPending: false, cleanupError: null }
    await mkdir(this.directory(id), { mode: 0o700 })
    await atomicWrite(join(this.directory(id), 'run.json'), jsonBytes(run))
    return run
  }

  get(id: string) {
    if (!isRunId(id)) return Promise.resolve(null)
    return readJson<RunRecord>(join(this.directory(id), 'run.json'))
  }

  async ids() { return (await readdir(this.root, { withFileTypes: true })).filter(e => e.isDirectory() && isRunId(e.name)).map(e => e.name) }

  async artifacts(id: string): Promise<Record<string, unknown>> {
    const run = await this.get(id)
    if (!run) return {}
    return Object.fromEntries(await Promise.all(run.artifacts.filter(a => knownArtifacts.includes(a)).map(async a =>
      [a, await readJson(join(this.directory(id), a))] as const)))
  }

  change(id: string, update: (r: RunRecord) => void | Promise<void>) {
    return this.serialized(async () => {
      const run = await this.get(id)
      if (!run) throw new Error('Run record unavailable')
      await update(run)
      run.updatedAt = new Date().toISOString()
      await atomicWrite(join(this.directory(id), 'run.json'), jsonBytes(run))
      return run
    })
  }

  private async writeArtifact(run: RunRecord, name: string, bytes: string) {
    if (!knownArtifacts.includes(name)) throw new Error('Unknown artifact')
    const file = join(this.directory(run.id), name)
    // Serialized under the process-wide writer lock. An existing file is always immutable.
    try { await stat(file); throw new Error('Artifact already published: ' + name) }
    catch (e) { if (!isMissing(e)) throw e }
    await atomicWrite(file, bytes)
    run.artifacts.push(name)
  }

  publish(id: string, name: string, value: unknown) {
    const bytes = jsonBytes(value)
    return this.change(id, async run => {
      if (run.status !== 'running') throw new Error('Run has stopped accepting artifacts')
      await this.writeArtifact(run, name, bytes)
      const match = /^proposals\/(v[12])\.json$/.exec(name)
      if (match) run.proposalDigests[match[1]] = digestOf(bytes)
    })
  }

  // Rejected model content stays in owner-only diagnostics, outside the API's
  // artifact allowlist. Publish only generated validation feedback and metadata.
  recordRejection(id: string, name: string, metadata: unknown, response: unknown) {
    if (!attemptArtifacts.includes(name)) throw new Error('Unknown attempt artifact')
    return this.change(id, async run => {
      if (run.status !== 'running') throw new Error('Run has stopped accepting artifacts')
      const privateName = name.replace(/^attempts\//, 'diagnostics/')
      const file = join(this.directory(id), privateName)
      try { await stat(file); throw new Error('Attempt diagnostics already saved') }
      catch (e) { if (!isMissing(e)) throw e }
      await atomicWrite(file, jsonBytes({ feedback: metadata, response }))
      await this.writeArtifact(run, name, jsonBytes(metadata))
    })
  }

  // Read the bytes the voters will review back from the immutable file.
  async proposalBytes(id: string, version: number) {
    if (version !== 1 && version !== 2) throw new Error('Invalid proposal version')
    return readFile(join(this.directory(id), `proposals/v${version}.json`), 'utf8')
  }

  finish(id: string, result: Result) {
    return this.change(id, async run => {
      await this.writeArtifact(run, 'result.json', jsonBytes(result))
      this.applyResult(run, result)
    })
  }

  private applyResult(run: RunRecord, result: Result) {
    run.status = result.status
    run.finishedAt ??= new Date().toISOString()
    if (result.status === 'failed') { run.error = result.error; run.stage = result.stage }
  }

  async reconcile(id: string) {
    const run = await this.get(id)
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return run
    return this.change(id, async fresh => {
      const directory = this.directory(id)
      fresh.artifacts = []
      for (const name of knownArtifacts) {
        const artifact = await readJson(join(directory, name))
        if (artifact === null) continue
        fresh.artifacts.push(name)
        const m = /^proposals\/(v[12])\.json$/.exec(name)
        if (m) fresh.proposalDigests[m[1]] = digestOf(await readFile(join(directory, name)))
        if (name === 'result.json') this.applyResult(fresh, artifact as Result)
      }
    })
  }
}
