export type Role = 'A' | 'B'
export type AgentStage = 'investigate' | 'critique' | 'draft' | 'revise' | 'vote'
export type RunStatus = 'queued' | 'running' | 'finalized' | 'unresolved' | 'failed'

export interface RunInput {
  repo: string
  issue: string
  head?: string
  base?: string
}

export interface PinnedInput {
  repo: string
  issue: string
  headRef: string
  headSha: string
  baseRef: string | null
  baseSha: string | null
}

export interface Evidence {
  commit: string
  path: string
  startLine: number
  endLine: number
  excerpt: string
}

export interface Report {
  hypothesis: string
  evidence: Evidence[]
  gaps: string[]
}

export interface Critique {
  assessment: string
  evidence: Evidence[]
  objections: string[]
}

export interface Proposal {
  cause: string
  explanation: string
  evidence: Evidence[]
  gaps: string[]
}

export interface Vote {
  version: number
  digest: string
  decision: 'approve' | 'object'
  objections: string[]
}

export interface StageOutput {
  investigate: Report
  critique: Critique
  draft: Proposal
  revise: Proposal
  vote: Vote
}

export interface AgentCall {
  runId: string
  role: Role
  stage: AgentStage
  cwd: string
  evidenceDir?: string
  prompt: string
  schema: Record<string, unknown>
  schemaPath: string
}

export type AgentAdapter = (call: AgentCall, signal: AbortSignal) => Promise<unknown>
export type Adapters = Record<Role, AgentAdapter>

export interface RunError {
  message: string
  role?: Role
}

export interface RunRecord {
  id: string
  input: PinnedInput
  agents: Record<Role, { adapter: string, model: string | null }>
  status: RunStatus
  stage: string
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  artifacts: string[]
  proposalDigests: Record<string, string>
  error: RunError | null
  workspaceRoot?: string
  cleanupPending: boolean
  cleanupError: string | null
}

export type Result =
  | { status: 'finalized', version: number, digest: string, proposal: Proposal }
  | { status: 'unresolved', version: number, digest: string, positions: Record<Role, Vote>, objections: string[] }
  | { status: 'failed', stage: string, error: RunError, artifacts: string[] }
