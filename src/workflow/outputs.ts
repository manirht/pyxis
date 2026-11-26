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
  // A named different target is a terminal provenance-policy incident, even
  // with extra fields. This is deliberately conservative, not a claim that a
  // fresh validated ballot could bypass the immutable version/digest checks.
  if (stage === 'vote' && target && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const vote = raw as Partial<Vote>
    if ((typeof vote.version === 'number' && vote.version !== target.version) ||
        (typeof vote.digest === 'string' && vote.digest !== target.digest))
      throw new ModelOutputError('vote-target', 'Vote targets a different proposal', raw)
  }
  const { validate } = shapes[stage]
  if (!validate(raw)) throw new ModelOutputError('schema', 'Invalid ' + stage + ' output: ' + ajv.errorsText(validate.errors))
  const output = raw as StageOutput[S]
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
