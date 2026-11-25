import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import type { RunInput, RunRecord } from '../types.ts'

export interface ApiService {
  submit(input: RunInput): Promise<RunRecord>
  get(id: string): Promise<RunRecord | null>
  artifacts(id: string): Promise<Record<string, unknown>>
}

const assets = new Map([
  ['/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
])
const maxBodyBytes = 64 * 1024

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readSubmission(request: IncomingMessage): Promise<RunInput> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Send the request as application/json.')
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    throw new HttpError(413, 'The request exceeds the 64 KiB limit.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBodyBytes) throw new HttpError(413, 'The request exceeds the 64 KiB limit.')
    chunks.push(chunk as Buffer)
  }
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new HttpError(400, 'Send a valid UTF-8 JSON object.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Send an object containing repo and issue.')
  }
  const values = input as Record<string, unknown>
  if (Object.keys(values).some(key => !['repo', 'issue', 'base', 'head'].includes(key))) {
    throw new HttpError(400, 'Supported request fields are repo, issue, base and head.')
  }
  if (typeof values.repo !== 'string' || !isAbsolute(values.repo) || values.repo.includes('\0')) {
    throw new HttpError(400, 'Provide the absolute path to a local Git repository.')
  }
  if (typeof values.issue !== 'string' || !values.issue.trim()) {
    throw new HttpError(400, 'Provide an issue description.')
  }
  const submission: RunInput = { repo: values.repo, issue: values.issue.trim() }
  for (const key of ['base', 'head'] as const) {
    const ref = values[key]
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !ref.trim() || ref.includes('\0')) {
        throw new HttpError(400, 'Each supplied Git ref must be a nonempty string.')
      }
      submission[key] = ref
    }
  }
  return submission
}

export async function startApi(service: ApiService, port = 4317) {
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      const listener = server.address()
      if (!listener || typeof listener === 'string') throw new HttpError(503, 'The service is stopping.')
      const allowedHosts = ['127.0.0.1', 'localhost'].map(host => host + (listener.port === 80 ? '' : ':' + listener.port))
      const host = request.headers.host?.toLowerCase()
      if (!host || !allowedHosts.includes(host)) throw new HttpError(403, 'Use the local service address.')
      if (request.headers.origin !== undefined && request.headers.origin !== 'http://' + host) {
        throw new HttpError(403, 'The request must originate from this local service.')
      }
      const path = request.url?.split('?')[0] ?? ''
      const asset = assets.get(path)
      if (asset && request.method === 'GET') {
        const body = await readFile(new URL(asset[0]!, import.meta.url))
        response.writeHead(200, { 'Content-Type': asset[1]! })
        response.end(body)
        return
      }
      if (path === '/runs' && request.method === 'POST') {
        const run = await service.submit(await readSubmission(request))
        response.setHeader('Location', '/runs/' + encodeURIComponent(run.id))
        json(response, 202, { runId: run.id, status: 'queued' })
        return
      }
      const runRoute = /^\/runs\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(\/artifacts)?$/.exec(path)
      if (runRoute && request.method === 'GET') {
        const id = runRoute[1]!
        const record = await service.get(id)
        if (!record) throw new HttpError(404, 'Run not found.')
        json(response, 200, runRoute[2] ? await service.artifacts(id) : record)
        return
      }
      if (path === '/runs' || runRoute || asset) {
        response.setHeader('Allow', path === '/runs' ? 'POST' : 'GET')
        throw new HttpError(405, 'Unsupported method for this route.')
      }
      throw new HttpError(404, 'Route not found.')
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      const inputError = error instanceof Error && error.name === 'InputError'
      const status = error instanceof HttpError ? error.status : inputError ? 400 : 500
      if (!request.complete) {
        response.shouldKeepAlive = false
        request.resume()
      }
      json(response, status, { error: status < 500 && error instanceof Error ? error.message : 'The local service could not complete the request.' })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to identify the local service address.')
  return {
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections()
    }),
  }
}
