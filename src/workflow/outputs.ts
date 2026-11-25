import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import type { AgentStage, StageOutput } from '../types.ts'

const ajv = new Ajv()
function load(name: string) {
  const path = fileURLToPath(new URL('../../schemas/' + name + '.json', import.meta.url))
  const schema: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'))
  return { schema, path, validate: ajv.compile(schema) }
}
const proposal = load('proposal')
export const shapes = { investigate: load('report'), critique: load('critique'), draft: proposal, revise: proposal, vote: load('vote') }

export function parseOutput<S extends AgentStage>(stage: S, raw: unknown): StageOutput[S] {
  const { validate } = shapes[stage]
  if (!validate(raw)) throw new Error('Invalid ' + stage + ' output: ' + ajv.errorsText(validate.errors))
  const output = raw as StageOutput[S]
  const strings = Object.values(output).flatMap(v => typeof v === 'string' ? [v] :
    Array.isArray(v) ? v.filter((s: unknown) => typeof s === 'string') : [])
  if (strings.some(s => !s.trim())) throw new Error('Empty text in ' + stage + ' output')
  if ('evidence' in output && output.evidence.length > 20) throw new Error('Maximum 20 citations per response')
  if ('evidence' in output && output.evidence.some(e => !e.excerpt.trim()))
    throw new Error('A citation must contain source text. Include adjacent lines when citing a blank line.')
  if ('decision' in output && (output.decision === 'object') !== (output.objections.length > 0))
    throw new Error('An objection requires reasons, and an approval requires no objections')
  return output
}
