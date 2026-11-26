import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindProvider, isProvider, type Provider, type ProviderModels } from './adapters/index.ts'
import { claimStore, RunStore } from './store.ts'
import { cleanWorkspace, executeRun, messageOf } from './workflow/rca.ts'
import { pinInput } from './workspace.ts'
import type { Adapters, PinnedInput, Role, RunInput, RunRecord } from './types.ts'

interface ServiceOptions extends ProviderModels {
  runsDir?: string
  tempRoot?: string
  stageTimeoutMs?: number
  adapters?: Adapters
  deferStart?: boolean
}
interface Config { roles: Record<Role, Provider>, stageTimeoutMs: number }

class InputError extends Error { override name = 'InputError' }

async function validateRequest(input: RunInput): Promise<PinnedInput> {
  if (!input || typeof input.issue !== 'string' || !input.issue.trim() || input.issue.length > 32_768)
    throw new InputError('Supply a non-empty issue of up to 32,768 characters')
  if (typeof input.repo !== 'string' || !isAbsolute(input.repo)) throw new InputError('Supply an absolute local repository path')
  for (const ref of [input.head, input.base]) {
    if (ref !== undefined && (typeof ref !== 'string' || !ref.trim() || ref.includes('\0') || ref.length > 1024))
      throw new InputError('Invalid Git ref')
  }
  try { return await pinInput({ ...input, issue: input.issue.trim() }) }
  catch (e) { throw new InputError(messageOf(e)) }
}

export async function openService(options: ServiceOptions = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const config: Config = JSON.parse(await readFile(join(root, 'rca.config.json'), 'utf8'))
  const timeout = options.stageTimeoutMs ?? config.stageTimeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error('Invalid stage timeout')
  for (const role of ['A', 'B'] as const) {
    if (!isProvider(config.roles[role])) throw new Error('Unknown adapter for role ' + role)
  }
  const tempRoot = resolve(options.tempRoot ?? join(tmpdir(), 'rca-harness'))
  const store = new RunStore(resolve(options.runsDir ?? join(root, 'runs')))
  const release = await claimStore(store.root)
  const shutdown = new AbortController()
  const queue: RunRecord[] = []
  const submissions = new Set<Promise<RunRecord>>()
  let active: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let started = !options.deferStart

  function kick() {
    if (!started || active || shutdown.signal.aborted || !queue.length) return
    const run = queue.shift()!
    // Queued jobs keep the bindings and model choices recorded at submission.
    active = (async () => {
      const bind = (role: Role) => {
        const { adapter, model } = run.agents[role]
        return bindProvider(adapter, model ?? undefined)
      }
      const adapters = options.adapters ?? { A: bind('A'), B: bind('B') }
      await executeRun(store, run, adapters, tempRoot, timeout, shutdown.signal)
    })()
      .catch(async error => {
        // Covers a crash window between publishing result.json and updating run.json.
        const current = await store.reconcile(run.id)
        if (current?.status === 'running' || current?.status === 'queued') {
          await store.finish(run.id, { status: 'failed', stage: current.stage, error: { message: messageOf(error) }, artifacts: current.artifacts })
        }
      })
      .catch(error => console.error('RCA storage error for', run.id, messageOf(error)))
      .finally(() => { active = undefined; kick() })
  }

  try {
    for (const id of await store.ids()) {
      const run = await store.reconcile(id)
      if (!run) continue
      if (run.status === 'running') {
        await store.finish(id, { status: 'failed', stage: run.stage,
          error: { message: 'Service interrupted during ' + run.stage }, artifacts: run.artifacts })
      }
      if (run.cleanupPending) await cleanWorkspace(store, run, tempRoot)
      if (run.status === 'queued') queue.push(run)
    }
    queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    kick()
  } catch (e) { await release(); throw e }

  const binding = (role: Role) => {
    const adapter = config.roles[role]
    const model = options[`${adapter}Model`]
    return { adapter, model: model ?? null }
  }

  async function enqueue(input: RunInput) {
    const pinned = await validateRequest(input)
    const run = await store.create(pinned, { A: binding('A'), B: binding('B') })
    queue.push(run)
    kick()
    return run
  }

  return {
    start() { started = true; kick() },
    submit(input: RunInput) {
      if (shutdown.signal.aborted) return Promise.reject(new Error('Service is shutting down'))
      const task = enqueue(input)
      submissions.add(task)
      void task.then(() => submissions.delete(task), () => submissions.delete(task))
      return task
    },
    storageRoot: store.root,
    reviewers: { A: binding('A'), B: binding('B') },
    list: () => store.list(),
    report: (id: string) => store.report(id),
    get: (id: string) => store.get(id),
    artifacts: (id: string) => store.artifacts(id),
    close() {
      if (!closing) {
        shutdown.abort(new Error('Service stopped during the active run'))
        closing = (async () => {
          try { await Promise.allSettled(submissions); await active }
          finally { await release() }
        })()
      }
      return closing
    },
  }
}
