import { digestOf, RunStore, type CallAudit } from '../store.ts'
import { prepareWorkspace, removeWorkspace, validateEvidence } from '../workspace.ts'
import type { Adapters, AgentStage, Proposal, Role, RunError, RunRecord, StageOutput, Vote } from '../types.ts'
import { makePrompt } from './prompts.ts'
import { parseOutput, shapes } from './outputs.ts'
import { ModelOutputError, MAX_MODEL_OUTPUT_ATTEMPTS } from '../output-error.ts'

class RoleFailure extends Error {
  role: Role
  constructor(role: Role, message: string) { super(message); this.role = role }
}
export const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e)

export async function cleanWorkspace(store: RunStore, run: RunRecord, tempRoot: string) {
  try {
    await removeWorkspace(run.input, run.id, run.workspaceRoot ?? tempRoot)
    await store.change(run.id, r => { r.cleanupPending = false; r.cleanupError = null })
  } catch (e) {
    await store.change(run.id, r => { r.cleanupPending = true; r.cleanupError = messageOf(e) })
  }
}

export async function executeRun(store: RunStore, run: RunRecord, adapters: Adapters, tempRoot: string,
  stageTimeoutMs: number, shutdown: AbortSignal) {
  const id = run.id
  let stage = 'prepare'
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>>
  const setStage = async (name: string) => {
    stage = name
    await store.change(id, r => { r.stage = name })
    shutdown.throwIfAborted()
  }
  async function call<S extends AgentStage>(role: Role, action: S, material: unknown, signal: AbortSignal,
    withContext = false): Promise<StageOutput[S]> {
    const { schema, path: schemaPath } = shapes[action]
    try {
      let feedback: { message: string, response: unknown } | undefined
      for (let attempt = 1; attempt <= MAX_MODEL_OUTPUT_ATTEMPTS; attempt++) {
        signal.throwIfAborted()
        let raw: unknown
        let audit: CallAudit | undefined
        try {
          const prompt = makePrompt(run, role, action, withContext ? workspace.context : '', material, feedback)
          audit = await store.startCall(id, { stage, action, role, attempt })
          signal.throwIfAborted()
          raw = await adapters[role]({ runId: id, role, stage: action, cwd: workspace.cwd,
            evidenceDir: workspace.evidenceDir, prompt, schema, schemaPath }, signal)
          signal.throwIfAborted()
          const target = action === 'vote' ? material as Pick<Vote, 'version' | 'digest'> : undefined
          const value = parseOutput(action, raw, target)
          if ('evidence' in value) await validateEvidence(run.input, value.evidence, signal)
          signal.throwIfAborted()
          await store.finishCall(id, audit, 'validated')
          return value
        } catch (e) {
          if (audit) {
            await store.finishCall(id, audit, e instanceof ModelOutputError ? 'rejected' : signal.aborted ? 'cancelled' : 'failed',
              e instanceof ModelOutputError ? e.category : undefined)
          }

          if (!(e instanceof ModelOutputError)) throw e
          const willRetry = !signal.aborted && e.retryable && attempt < MAX_MODEL_OUTPUT_ATTEMPTS
          const response = e.response ?? raw ?? null
          await store.recordRejection(id, `attempts/${stage}/${role}-${attempt}.json`,
            { stage, role, attempt, category: e.category, message: e.message, willRetry }, response)
          signal.throwIfAborted()
          if (!willRetry) throw new Error(e.message + (e.retryable ? ` Recovery exhausted after ${MAX_MODEL_OUTPUT_ATTEMPTS} attempts.` : ''))
          feedback = { message: e.message, response }
        }
      }
      throw new Error('Stage recovery exhausted')
    } catch (e) {
      throw new RoleFailure(role, messageOf(signal.aborted ? signal.reason : e))
    }
  }
  async function deadline<T>(work: (signal: AbortSignal, stop: AbortController) => Promise<T>) {
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(new Error(stage + ' timed out')), stageTimeoutMs)
    const signal = AbortSignal.any([shutdown, stop.signal])
    try {
      const result = await work(signal, stop)
      signal.throwIfAborted()
      return result
    }
    finally { clearTimeout(timer) }
  }
  function pair<T>(work: (role: Role, signal: AbortSignal) => Promise<T>): Promise<Record<Role, T>> {
    return deadline(async (signal, stop) => {
      let firstError: Error | undefined
      const invoke = async (role: Role) => {
        try { return await work(role, signal) }
        catch (e) {
          firstError ??= e instanceof RoleFailure ? e : new RoleFailure(role, messageOf(e))
          stop.abort(firstError)
          throw e
        }
      }
      // Wait for the sibling to stop before removing the checkout, even on failure.
      const [a, b] = await Promise.allSettled([invoke('A'), invoke('B')])
      if (a.status === 'rejected' || b.status === 'rejected') throw firstError
      return { A: a.value, B: b.value }
    })
  }

  try {
    await store.change(id, r => { r.status = 'running'; r.stage = stage; r.workspaceRoot = tempRoot; r.cleanupPending = true })
    shutdown.throwIfAborted()
    workspace = await deadline(signal => prepareWorkspace(run.input, id, tempRoot, signal))
    await setStage('investigate')
    const reports = await pair(async (role, signal) => {
      const report = await call(role, 'investigate', null, signal, true)
      await store.publish(id, 'reports/' + role + '.json', report)
      return report
    })
    await setStage('critique')
    const critiques = await pair(async (role, signal) => {
      const peer = role === 'A' ? 'B' : 'A'
      const response = await call(role, 'critique', { peer, report: reports[peer] }, signal, true)
      await store.publish(id, `critiques/${role}-on-${peer}.json`, response)
      return response
    })

    let material: unknown = { reports, critiques }
    for (const version of [1, 2]) {
      const action = version === 1 ? 'draft' : 'revise'
      await setStage(action)
      const proposal = await deadline(signal => call('A', action, material, signal))
      const saved = await store.publish(id, `proposals/v${version}.json`, proposal)
      const bytes = await store.proposalBytes(id, version)
      const digest = digestOf(bytes)
      if (digest !== saved.proposalDigests['v' + version]) throw new Error('Saved proposal digest mismatch')
      const frozen: Proposal = JSON.parse(bytes)
      await setStage('vote-v' + version)
      const positions = await pair(async (role, signal) => {
        const vote = await call(role, 'vote', { version, digest, proposalBytes: bytes }, signal)
        await store.publish(id, `votes/v${version}/${role}.json`, { ...vote, runId: id, role })
        return vote
      })
      const objections = Object.entries(positions).flatMap(([role, v]: [string, Vote]) => v.objections.map(x => role + ': ' + x))
      if (!frozen.evidence.length) objections.push('The proposal has no verified source citation.')
      if (!objections.length) {
        await store.finish(id, { status: 'finalized', version, digest, proposal: frozen })
        return
      }
      if (version === 2) {
        await store.finish(id, { status: 'unresolved', version, digest, positions, objections })
        return
      }
      material = { reports, critiques, previousProposal: frozen, positions, objections }
    }
  } catch (e) {
    const error: RunError = { message: messageOf(e) }
    if (e instanceof RoleFailure) error.role = e.role
    // An artifact rename can succeed even when publication of its manifest fails.
    const current = await store.reconcile(id)
    if (current?.status === 'running' || current?.status === 'queued')
      await store.finish(id, { status: 'failed', stage, error, artifacts: current.artifacts })
  } finally {
    await cleanWorkspace(store, run, tempRoot)
  }
}
