import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import type { AgentStage, StageOutput, Vote } from '../types.ts'
import { ModelOutputError } from '../output-error.ts'

const ajv = new Ajv()
function load(name: string) {
  const path = fileURLToPath(new URL('../../schemas/' + name + '.json', import.meta.url))
  const schema: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'))
  return { schema, path, validate: ajv.compile(schema) }
}
const proposal = load('proposal')
export const shapes = { investigate: load('report'), critique: load('critique'), draft: proposal, revise: proposal, vote: load('vote') }

export function parseOutput<S extends AgentStage>(stage: S, raw: unknown,
  target?: Pick<Vote, 'version' | 'digest'>): StageOutput[S] {
  const { validate } = shapes[stage]
  if (!validate(raw)) throw new ModelOutputError('schema', 'Invalid ' + stage + ' output: ' + ajv.errorsText(validate.errors))
  const output = raw as StageOutput[S]
  // Bind a well-shaped ballot before retryable text/decision validation can mask a stale target.
  if (stage === 'vote' && target) {
    const vote = output as Vote
    if (vote.version !== target.version || vote.digest !== target.digest)
      throw new ModelOutputError('vote-target', 'Vote targets a different proposal', raw, false)
  }
  const strings = Object.values(output).flatMap(v => typeof v === 'string' ? [v] :
    Array.isArray(v) ? v.filter((s: unknown) => typeof s === 'string') : [])
  if (strings.some(s => !s.trim())) throw new ModelOutputError('schema', 'Empty text in ' + stage + ' output')
  if ('evidence' in output && output.evidence.length > 20) throw new ModelOutputError('schema', 'Maximum 20 citations per response')
  if ('evidence' in output && output.evidence.some(e => !e.excerpt.trim()))
    throw new ModelOutputError('citation', 'A citation must contain source text. Include adjacent lines when citing a blank line.')
  if ('decision' in output && (output.decision === 'object') !== (output.objections.length > 0))
    throw new ModelOutputError('schema', 'An objection requires reasons, and an approval requires no objections')
  return output
}
