import type { Role, RunRecord } from './types.ts'

export interface CallAudit {
  stage: string
  action: string
  role: Role
  attempt: number
  provider: string
  model: string | null
  startedAt: string
}

export interface RunEvent {
  timestamp: string
  kind: 'run-created' | 'run-state' | 'artifact-published' | 'call-started' | 'call-finished'
  stage: string
  status: string
  artifact?: string
  action?: string
  role?: Role
  attempt?: number
  provider?: string
  model?: string | null
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  category?: string
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const string = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value) ?? ''
const longestBackticks = (text: string) => {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}
const code = (value: unknown) => {
  const text = string(value).replace(/[\r\n]+/g, ' ')
  const delimiter = '`'.repeat(longestBackticks(text) + 1)
  return delimiter + ' ' + text + ' ' + delimiter
}
const block = (value: unknown, language = 'text') => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const fence = '`'.repeat(Math.max(2, longestBackticks(text ?? '')) + 1)
  return `${fence}${language}\n${text ?? ''}\n${fence}`
}
const labels: Record<string, string> = {
  hypothesis: 'Hypothesis', assessment: 'Assessment', cause: 'Root cause', explanation: 'Explanation',
  evidence: 'Source citations', gaps: 'Evidence gaps', objections: 'Objections', status: 'Status',
  version: 'Proposal version', digest: 'Proposal SHA-256', decision: 'Decision', role: 'Role',
  runId: 'Run ID', stage: 'Stage', attempt: 'Attempt', category: 'Rejection category',
  message: 'Message', willRetry: 'Retry planned', proposal: 'Final proposal', positions: 'Final positions',
  error: 'Failure', artifacts: 'Artifacts retained at failure',
}

// Only published artifacts reach this renderer. Never read private prompts or diagnostics here.
function document(value: unknown, level = 3): string[] {
  const fields = object(value)
  if (!fields) return [block(value, 'json')]
  const lines: string[] = []
  for (const [key, item] of Object.entries(fields)) {
    lines.push(`${'#'.repeat(Math.min(level, 6))} ${labels[key] ?? key}`, '')
    if (key === 'evidence' && Array.isArray(item)) {
      if (!item.length) lines.push('None recorded.', '')
      for (const [index, citation] of item.entries()) {
        const entry = object(citation)
        if (!entry) { lines.push(block(citation, 'json'), ''); continue }
        lines.push(`Citation ${index + 1}: ${code(entry.path)} lines ${code(entry.startLine)}–${code(entry.endLine)}`, '',
          `Commit: ${code(entry.commit)}`, '', block(entry.excerpt), '')
      }
    } else if (Array.isArray(item)) {
      if (!item.length) lines.push('None recorded.', '')
      else for (const entry of item) lines.push(block(entry, typeof entry === 'string' ? 'text' : 'json'), '')
    } else if (object(item)) {
      lines.push(...document(item, level + 1))
    } else {
      // Treat model prose as literal text, including HTML and Markdown fence characters.
      lines.push(block(item), '')
    }
  }
  return lines
}

export function renderRunReport(run: RunRecord, artifacts: Record<string, unknown>): string {
  const lines = ['# Pyxis investigation record', '', `Run: ${code(run.id)}`, '',
    `Status: **${run.status}** · Stage: ${code(run.stage)}`, '',
    `Created: ${code(run.createdAt)} · Updated: ${code(run.updatedAt)}`, '',
    `Finished: ${run.finishedAt ? code(run.finishedAt) : 'In progress / not recorded'}`, '',
    '## Reported issue', '', block(run.input.issue), '',
    '## Pinned repository', '', `Repository: ${code(run.input.repo)}`, '',
    `Head ref: ${code(run.input.headRef)} · Commit: ${code(run.input.headSha)}`, '',
    run.input.baseSha ? `Base ref: ${code(run.input.baseRef)} · Commit: ${code(run.input.baseSha)}` : 'Base comparison: none supplied.', '',
    '## Reviewers', '']
  for (const role of ['A', 'B'] as const) {
    const binding = run.agents[role]
    lines.push(`Role ${role}: ${code(binding.adapter)} · Model: ${binding.model ? code(binding.model) : 'CLI default (exact model not recorded)'}`, '')
  }
  lines.push('## Outcome', '')
  if (run.status === 'finalized') lines.push('Both reviewers approved the saved proposal version and digest, with verified source citations.', '')
  else if (run.status === 'unresolved') lines.push('The reviewers did not reach agreement after the permitted revision. Their saved positions and objections follow.', '')
  else if (run.status === 'failed') lines.push('Execution stopped before an agreed RCA was finalized. Published partial outputs remain below.', '')
  else lines.push('The investigation has not reached a terminal outcome. This report is a snapshot of published work.', '')
  lines.push('Source-citation validation checks excerpts against pinned Git objects. This record does not establish that target-repository tests or runtime reproduction were executed.', '')
  if (run.error) lines.push('### Run failure', '', ...document(run.error, 4))
  if (run.cleanupPending || run.cleanupError) {
    lines.push('### Workspace cleanup', '', `Pending: ${run.cleanupPending ? 'yes' : 'no'}`, '')
    if (run.cleanupError) lines.push(block(run.cleanupError), '')
  }
  const groups: [string, (name: string) => boolean][] = [
    ['Final result', name => name === 'result.json'],
    ['Independent investigations', name => name.startsWith('reports/')],
    ['Cross critiques', name => name.startsWith('critiques/')],
    ['Proposals', name => name.startsWith('proposals/')],
    ['Votes', name => name.startsWith('votes/')],
    ['Rejected attempts and validation feedback', name => name.startsWith('attempts/')],
  ]
  for (const [heading, matches] of groups) {
    lines.push(`## ${heading}`, '')
    const names = Object.keys(artifacts).filter(matches).sort()
    if (!names.length) lines.push('No published output.', '')
    for (const name of names) lines.push(`### ${code(name)}`, '', ...document(artifacts[name], 4))
  }
  lines.push('## File index', '', '- `run.json` — pinned input, reviewers, state and publication manifest.',
    '- `REPORT.md` — this regenerated readable snapshot.',
    '- `events.jsonl` — local lifecycle and call timing audit, when recorded.', '')
  for (const name of Object.keys(artifacts).sort()) lines.push(`- ${code(name)}`)
  lines.push('', 'The report and artifacts API exclude private workflow prompts and rejected response bodies. Older imported runs may have no call timing audit or workflow prompts. Prompt files preserve the full workflow prompt passed to the adapter; adapters can add output-schema instructions, and the launcher prepends pinned-checkout locations. Saved prompts are not exact provider stdin or full native CLI transcripts. Full workflow prompts and raw rejected responses are retained only on POSIX; Windows omits both because POSIX modes cannot enforce private Windows ACLs.', '')
  return lines.join('\n')
}
