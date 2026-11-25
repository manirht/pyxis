import { execFile, spawn } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCall } from '../types.ts';
import { prepareCopilotLaunch } from './copilot-home.ts';

type Provider = 'claude' | 'codex' | 'copilot';
const displayNames = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot' };
const maxOutputBytes = 2 * 1024 * 1024;
const diagnosticBytes = 8192;
const execFileAsync = promisify(execFile);
const windowsSupervisor = process.platform === 'win32'
  ? Buffer.from(readFileSync(new URL('./windows-job.ps1', import.meta.url), 'utf8'), 'utf16le').toString('base64')
  : '';

function windowsArguments(args: string[]): string {
  // Encode each argument independently for the Windows native argv parser.
  // Backslashes preceding a literal quote or the final delimiter are doubled.
  return args.map(value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"').join(' ');
}

function searchDirectories(): string[] {
  return (process.env.PATH ?? '').split(delimiter)
    .map(entry => entry.replace(/^"(.*)"$/, '$1'))
    .filter(entry => isAbsolute(entry));
}

async function resolveExecutable(provider: Provider): Promise<string> {
  const filename = process.platform === 'win32' ? provider + '.exe' : provider;
  for (const directory of searchDirectories()) {
    const candidate = join(directory, filename);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // A missing or inaccessible PATH entry is normal.
    }
  }
  throw new Error(`${displayNames[provider]} executable was not found on PATH. Install ${filename} and restart the service.`);
}

// Forward OS, certificate and login settings. Desktop session IDs, injected
// runtime options, provider plugins and the other provider's tokens stay out.
function providerEnvironment(provider: Provider): NodeJS.ProcessEnv {
  const common = /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|OS|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|PROCESSOR_ARCHITECTURE|HOME|USER|USERNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_\w+|TZ|XDG_\w+|DBUS_SESSION_BUS_ADDRESS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i;
  const auth = {
    claude: /^(ANTHROPIC_\w+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|AWS_\w+|GOOGLE_\w+|CLOUD_ML_REGION|AZURE_\w+)$/i,
    codex: /^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_HOME)$/i,
    copilot: /^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|GH_HOST|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i,
  }[provider];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (common.test(key) || auth.test(key)) {
      env[key] = key.toUpperCase() === 'PATH' ? searchDirectories().join(delimiter) : value;
    }
  }
  return env;
}

function cancellation(label: string, signal: AbortSignal): Error {
  const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  const error = new Error(`${label} ${timedOut ? 'timed out' : 'was cancelled'}.`);
  error.name = timedOut ? 'TimeoutError' : 'AbortError';
  return error;
}

async function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    try {
      await execFileAsync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      return;
    } catch {
      // The child may have exited while taskkill was starting.
    }
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

// Only fixed diagnostic categories are published. CLI stderr can contain the
// entire input diff, local paths, and credential-bearing service responses.
function failureDetail(output: string): string {
  if (output.includes('RCA_WINDOWS_JOB_START_FAILED')) return ' The Windows process supervisor could not start the program.';
  const unknownOption = /^\s*error: unknown option ['"](--[a-z0-9-]{1,60})\b/im.exec(output);
  if (unknownOption) return ' The installed CLI does not recognize ' + unknownOption[1] + '.';
  if (/not logged in|unauthenticated|authentication failed|invalid (?:api key|authentication)|401 unauthorized/i.test(output)) {
    return ' Check the CLI login or provider credentials.';
  }
  if (/rate.limit exceeded|429 too many requests|usage limit reached|insufficient_quota/i.test(output)) {
    return ' The provider reported a usage or rate limit.';
  }
  if (/connection refused|connection reset|failed to connect|network (?:error|unreachable)/i.test(output)) {
    return ' The provider connection failed.';
  }
  return '';
}

export interface ProcessRequest {
  executable: string;
  args: string[];
  label: string;
  cwd: string;
  input: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}

export function runProcess(request: ProcessRequest): Promise<string> {
  const { executable, args, label, cwd, input, signal, env } = request;
  if (signal.aborted) return Promise.reject(cancellation(label, signal));

  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const supervisor = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // PowerShell executes only the fixed supervisor. Provider arguments and
    // stdin go to the native executable as data, without shell interpolation.
    const child = spawn(windows ? supervisor : executable,
      windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', windowsSupervisor] : args, {
      cwd, shell: false, windowsHide: true,
      env: windows ? {
        ...env, RCA_JOB_EXECUTABLE: executable, RCA_JOB_ARGUMENTS: windowsArguments(args),
        RCA_JOB_PARENT: String(process.pid),
      } : env,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    let stdinFailed = false;
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;

    function stop(reason: Error) {
      if (failure) return;
      failure = reason;
      if (child.pid !== undefined) {
        stopping = stopProcessTree(child.pid).catch(() => {
          failure = new Error(`${label} process could not be stopped cleanly.`);
        }).finally(() => {
          // An already-exited launcher can leave its pipes open in a descendant.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        });
      }
    }

    const onAbort = () => stop(cancellation(label, signal));
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new Error(`${label} response exceeded the 2 MiB output limit.`));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const tail = Buffer.concat([stderr, chunk.subarray(-diagnosticBytes)]);
      stderr = tail.subarray(-diagnosticBytes);
    });
    child.once('error', () => {
      failure ??= new Error(`${label} process could not start. Check the executable and its permissions.`);
    });
    child.stdin.on('error', () => { stdinFailed = true; });
    child.once('close', async (code, exitSignal) => {
      signal.removeEventListener('abort', onAbort);
      await stopping;
      if (failure) return reject(failure);
      const output = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        const status = code === null ? `on signal ${exitSignal}` : `with exit code ${code}`;
        return reject(new Error(`${label} stopped ${status}.${failureDetail(stderr.toString('utf8') + '\n' + output)}`));
      }
      if (stdinFailed) return reject(new Error(`${label} closed its input before receiving the prompt.`));
      resolve(output);
    });
    child.stdin.end(input, 'utf8');
  });
}

export type InvokeProvider = (provider: Provider, args: string[], call: AgentCall, signal: AbortSignal) => Promise<string>;

let copilotCapability: { executable: string; modified: number; exportFlag: string } | undefined;

async function copilotExportFlag(request: ProcessRequest): Promise<string> {
  const { mtimeMs } = await stat(request.executable);
  if (copilotCapability?.executable === request.executable && copilotCapability.modified === mtimeMs) {
    return copilotCapability.exportFlag;
  }
  // --no-auto-update selects the binary's bundled CLI. Its flags can differ
  // from the newer cached package that a plain "copilot --version" describes.
  const usage = await runProcess({ ...request, args: ['--no-auto-update', '--help'], input: '' });
  const exportFlag = usage.includes('--sync-session') ? '--sync-session=off' : '--no-remote-export';
  if (!usage.includes('--available-tools') || !usage.includes(exportFlag.split('=')[0])) {
    throw new Error('The installed GitHub Copilot CLI version does not support restricted local sessions.');
  }
  copilotCapability = { executable: request.executable, modified: mtimeMs, exportFlag };
  return exportFlag;
}

export const invokeProvider: InvokeProvider = async (provider, args, call, signal) => {
  const label = displayNames[provider];
  if (signal.aborted) throw cancellation(label, signal);
  const executable = await resolveExecutable(provider);
  // CLIs discover project configuration at startup. Give each call its
  // own empty working directory and grant read access to the pinned source.
  const scratchRoot = resolve(tmpdir());
  const scratch = await mkdtemp(join(scratchRoot, 'rca-agent-'));
  try {
    const locations = ['Pinned head checkout for read-only inspection: ' + JSON.stringify(call.cwd)];
    if (call.evidenceDir) locations.push('Additional read-only Git evidence: ' + JSON.stringify(call.evidenceDir));
    const env = providerEnvironment(provider);
    const launch = provider === 'copilot' ? await prepareCopilotLaunch(scratch, call, env) : { cwd: scratch, env };
    const request: ProcessRequest = {
      executable, args, ...launch, label, signal,
      input: locations.join('\n') + '\n\n' + call.prompt,
    };
    if (provider === 'copilot') request.args = [...args, await copilotExportFlag(request)];
    return await runProcess(request);
  } finally {
    if (dirname(scratch) === scratchRoot) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  }
};

export function parseOutput(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned an invalid JSON response.`);
  }
}
