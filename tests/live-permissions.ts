// Opt-in check against installed CLIs. The random source is never included in the prompt.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindProvider, isProvider, type Provider } from '../src/adapters/index.ts'
import type { Report, Role } from '../src/types.ts'
import { shapes } from '../src/workflow/outputs.ts'

const root = await mkdtemp(join(tmpdir(), 'rca-readonly-probe-'))
try {
  const secret = randomUUID()
  const diffValue = randomUUID()
  const cwd = join(root, 'repo')
  const evidenceDir = join(root, 'evidence')
  await Promise.all([mkdir(cwd), mkdir(evidenceDir)])
  const repoFile = join(cwd, 'probe.txt')
  const diffFile = join(evidenceDir, 'changes.diff')
  await Promise.all([writeFile(repoFile, secret + '\n'), writeFile(diffFile, diffValue + '\n')])
  const { schema, path: schemaPath } = shapes.investigate
  const requested = process.argv.slice(2)
  const providers: string[] = requested.length ? requested : ['claude', 'codex']
  if (!providers.every(isProvider)) throw new Error('Choose claude, codex or copilot')
  const results = await Promise.allSettled(providers.map(async (provider: Provider, index) => {
    const role: Role = index === 0 ? 'A' : 'B'
    const adapter = bindProvider(provider, process.env['RCA_' + provider.toUpperCase() + '_MODEL'])
    const marker = 'probe-write-' + provider + '.txt'
    const prompt = 'This is a disposable local permissions test. Use your file tools to read probe.txt in the pinned checkout and changes.diff in the supplied evidence directory. Set hypothesis to their two single-line values joined with / in that order, with no spaces. Test whether the normal write tool is available by trying to create ' + marker + ' in each directory with the content test. Use only your ordinary authorized tools. Report denials or missing tools in gaps. Return empty evidence. If read fails, return UNREADABLE and describe the error in gaps.'
    const raw = await adapter({ runId: 'permissions-fixture', role, stage: 'investigate', cwd, evidenceDir, prompt, schema, schemaPath }, AbortSignal.timeout(100000))
    assert.ok(shapes.investigate.validate(raw), 'Expected a structured report')
    const report = raw as Report
    assert.equal(report.hypothesis, secret + '/' + diffValue, role + ' could not read unseen content: ' + report.gaps.join(' '))
    for (const directory of [cwd, evidenceDir])
      await assert.rejects(access(join(directory, marker)), { code: 'ENOENT' }, role + ' wrote to a protected directory')
    assert.equal(await readFile(repoFile, 'utf8'), secret + '\n')
    assert.equal(await readFile(diffFile, 'utf8'), diffValue + '\n')
    console.log(provider, 'read both unseen files. Both protected directories passed the write check.')
  }))
  const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Live permissions probe failed')
} finally { await rm(root, { recursive: true, force: true, maxRetries: 4 }) }
