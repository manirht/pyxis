export const MAX_MODEL_OUTPUT_ATTEMPTS = 3

// Only errors about a completed model answer are eligible for regeneration.
// Transport, process, cancellation and storage errors must remain terminal.
export class ModelOutputError extends Error {
  readonly category: 'json' | 'schema' | 'citation' | 'empty' | 'vote-target'
  readonly response: unknown
  constructor(category: ModelOutputError['category'], message: string, response?: unknown) {
    super(message)
    this.category = category
    this.response = response
  }
  get retryable() { return this.category !== 'vote-target' }
}
