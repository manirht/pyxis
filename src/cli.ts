#!/usr/bin/env node
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startApi } from './api/server.ts'
import type { RunInput } from './types.ts'

const usage = `RCA harness

  rca serve [--port 4317]
  rca run --repo <path> --issue <description> [--base <ref>] [--head <ref>] [--port 4317]

Start the service once. Submit an issue from any local repository or script.
The default head is HEAD. Supply a base to compare against a known-good revision.
Submission prints JSON containing the runId. Open the local dashboard at
http://127.0.0.1:4317/#<runId> or poll GET /runs/<runId>.

To use GitHub Copilot CLI, set roles.A or roles.B to "copilot" in
rca.config.json before starting the service.

Service settings
  RCA_PORT              Local HTTP port, default 4317
  RCA_RUNS_DIR          Directory for durable run records
  RCA_TEMP_ROOT         Directory for temporary checkouts
  RCA_STAGE_TIMEOUT_MS  Deadline per agent stage in milliseconds
  RCA_CLAUDE_MODEL      Optional Claude model override
  RCA_CODEX_MODEL       Optional Codex model override
  RCA_COPILOT_MODEL     Optional GitHub Copilot model override
`

function integer(value: string, name: string, min: number, max: number) {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(name + ' must be an integer from ' + min + ' to ' + max + '.')
  }
  return number
}

async function serve(args: string[]) {
  const { values } = parseArgs({ args, options: { port: { type: 'string' } } })
  const port = integer(values.port ?? process.env.RCA_PORT ?? '4317', 'Port', 0, 65535)
  const timeout = process.env.RCA_STAGE_TIMEOUT_MS
  const { openService } = await import('./service.ts')
  const service = await openService({
    deferStart: true,
    ...(process.env.RCA_RUNS_DIR && { runsDir: resolve(process.env.RCA_RUNS_DIR) }),
    ...(process.env.RCA_TEMP_ROOT && { tempRoot: resolve(process.env.RCA_TEMP_ROOT) }),
    ...(timeout && { stageTimeoutMs: integer(timeout, 'Stage timeout', 1, 2_147_483_647) }),
    ...(process.env.RCA_CLAUDE_MODEL && { claudeModel: process.env.RCA_CLAUDE_MODEL }),
    ...(process.env.RCA_CODEX_MODEL && { codexModel: process.env.RCA_CODEX_MODEL }),
    ...(process.env.RCA_COPILOT_MODEL && { copilotModel: process.env.RCA_COPILOT_MODEL }),
  })
  try {
    const api = await startApi(service, port)
    service.start()
    process.stderr.write('RCA harness listening at ' + api.origin + '\n')
    await new Promise<void>(resolveStop => {
      const stop = () => {
        process.off('SIGTERM', stop)
        process.off('SIGINT', stop)
        resolveStop()
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    })
    await api.close()
  } finally {
    await service.close()
  }
}

async function submit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' }, issue: { type: 'string' }, head: { type: 'string' },
      base: { type: 'string' }, port: { type: 'string' },
    },
  })
  if (!values.repo?.trim() || !values.issue?.trim()) {
    throw new Error('Provide --repo <path> and --issue <description>.')
  }
  const port = integer(values.port ?? process.env.RCA_PORT ?? '4317', 'Port', 1, 65535)
  const origin = 'http://127.0.0.1:' + port
  const request: RunInput = { repo: resolve(values.repo), issue: values.issue }
  if (values.base !== undefined) request.base = values.base
  if (values.head !== undefined) request.head = values.head
  let response: Response
  try {
    response = await fetch(origin + '/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error('Cannot submit to ' + origin + ' (' + cause + '). Start the service with rca serve --port ' + port + '.')
  }
  const result: unknown = await response.json()
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result ? String(result.error) : 'HTTP ' + response.status
    throw new Error(message)
  }
  if (!result || typeof result !== 'object' || !('runId' in result) || typeof result.runId !== 'string') {
    throw new Error('The local service returned an invalid submission response.')
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h' || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(usage)
  } else if (command === 'serve') {
    await serve(args)
  } else if (command === 'run') {
    await submit(args)
  } else {
    throw new Error('Unknown command. Run rca --help for usage.')
  }
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})
