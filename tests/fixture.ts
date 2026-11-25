import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

export const exec = promisify(execFile)
export const issue = 'isExpired(61, 60000) returns false, although a session expiring at 60 seconds should be expired after 61 seconds.'
export const file = 'src/expiry.ts'
export const buggyLine = '  return nowSeconds >= expiresAtMs'

export async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rca-acceptance-'))
  const repo = join(root, 'example repository')
  const source = join(repo, file)
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=' + join(root, 'no-hooks'),
    '-c', 'user.name=RCA Fixture', '-c', 'user.email=rca@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: repo, windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T12:00:00Z' },
  })
  const commit = async (line: string, message: string) => {
    await writeFile(source, 'export function isExpired(nowSeconds: number, expiresAtMs: number): boolean {\n' + line + '\n}\n')
    await git('add', '--', file)
    await git('commit', '-qm', message)
    return (await git('rev-parse', 'HEAD')).stdout.trim()
  }
  await mkdir(dirname(source), { recursive: true })
  await git('init', '-q')
  const base = await commit('  return nowSeconds * 1000 >= expiresAtMs', 'Compare timestamps in milliseconds')
  const head = await commit(buggyLine, 'Change expiry comparison')
  return { root, repo, base, head,
    evidence: { commit: head, path: file, startLine: 2, endLine: 2, excerpt: buggyLine },
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 4 }),
  }
}
