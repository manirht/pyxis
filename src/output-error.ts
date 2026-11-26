export const MAX_MODEL_OUTPUT_ATTEMPTS = 3

// Only errors about a completed model answer are eligible for regeneration.
// Transport, process, cancellation and storage errors must remain terminal.
export class ModelOutputError extends Error {
  category: 'json' | 'schema' | 'citation' | 'empty' | 'vote-target'
  response: unknown
  retryable: boolean
  constructor(category: ModelOutputError['category'], message: string, response?: unknown, retryable = true) {
    super(message)
    this.category = category
    this.response = response
    this.retryable = retryable
  }
}
