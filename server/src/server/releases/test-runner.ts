/**
 * Run an app's own tests (`tests/*.test.ts`) for the validation pipeline —
 * outside the server process, in an OS sandbox (mutabl spec §7.2):
 *
 *  - a throwaway copy of the app in a temp dir (the draft itself is untouched);
 *  - macOS `sandbox-exec`: no outbound network, writes only to the temp dir,
 *    no reads of the Moumantai home, ~/.ssh, ~/.claude, ~/.config, keychains;
 *  - scrubbed environment (no credentials), wall-clock timeout.
 *
 * Elsewhere (no sandbox-exec) it falls back to env scrub + timeout and says so.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyReleaseFiles, listReleaseFiles } from './hash.js'

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const LOG_LIMIT = 8_000

export interface AppTestResult {
  /** False when the app has no tests (not a failure). */
  ran: boolean
  ok: boolean
  sandboxed: boolean
  summary: string
  /** Tail of the runner output, bounded. */
  log: string
  durationMs: number
}

export interface RunAppTestsOptions {
  appDir: string
  appId: string
  /** Moumantai repo root (node_modules + SDK sources for aliases). */
  repoRoot: string
  /** Directories the tests must not read (Moumantai home, credentials). */
  denyRead: string[]
  timeoutMs?: number
}

function sbString(s: string): string {
  return JSON.stringify(s) // SBPL string literals use the same escaping
}

/** SBPL profile: deny network + all writes except the work/tmp dirs + reads of secrets. */
export function sandboxProfile(writable: string[], denyRead: string[]): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound (remote ip))',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${sbString(p)})`).join(' ')} (literal "/dev/null") (regex #"^/dev/(tty|fd/|stdout|stderr)"))`,
    ...denyRead.map((p) => `(deny file-read* (subpath ${sbString(p)}))`),
  ].join('\n')
}

function viteConfig(repoRoot: string, work: string): string {
  const server = path.join(repoRoot, 'server', 'src', 'server')
  const protocol = path.join(repoRoot, 'shared', 'protocol')
  const alias = [
    ['moumantai/ui', path.join(server, 'protocol', 'components', 'index.ts')],
    ['moumantai', path.join(server, 'framework', 'moumantai.ts')],
    [
      '@moumantai/protocol/generated/moumantai/v1',
      path.join(protocol, 'src', 'generated', 'moumantai', 'v1', 'index.ts'),
    ],
    [
      '@moumantai/protocol/design-system',
      path.join(protocol, 'design-system', 'generated', 'design-system.ts'),
    ],
    ['@moumantai/protocol', path.join(protocol, 'src', 'index.ts')],
  ].map(([find, replacement]) => ({ find, replacement }))
  // Plain object: no imports, so nothing is bundled or resolved outside `work`.
  return `export default ${JSON.stringify(
    {
      cacheDir: path.join(work, '.vite'),
      resolve: { alias },
      test: { root: work, include: ['*/tests/**/*.test.ts'], environment: 'node' },
    },
    null,
    2,
  )}\n`
}

export async function runAppTests(opts: RunAppTestsOptions): Promise<AppTestResult> {
  const started = Date.now()
  const tests = listReleaseFiles(opts.appDir).filter((f) => /^tests\/.*\.test\.ts$/.test(f))
  if (tests.length === 0) {
    return { ran: false, ok: true, sandboxed: false, summary: 'no tests', log: '', durationMs: 0 }
  }

  const tmp = fs.realpathSync(os.tmpdir())
  const work = fs.mkdtempSync(path.join(tmp, 'mutabl-tests-'))
  try {
    copyReleaseFiles(opts.appDir, path.join(work, opts.appId))
    linkNodeModules(path.join(opts.repoRoot, 'node_modules'), path.join(work, 'node_modules'))
    const config = path.join(work, 'vitest.config.mjs')
    fs.writeFileSync(config, viteConfig(opts.repoRoot, work))
    const report = path.join(work, 'report.json')
    const vitest = [
      path.join(opts.repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config',
      config,
      '--root',
      work,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
    ]
    const sandboxed = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC)
    // The sandbox matches real paths (/var → /private/var on macOS).
    const denyRead = opts.denyRead.filter((d) => fs.existsSync(d)).map((d) => fs.realpathSync(d))
    const profile = sandboxProfile([work, tmp], denyRead)
    const [cmd, args] = sandboxed
      ? [SANDBOX_EXEC, ['-p', profile, process.execPath, ...vitest]]
      : [process.execPath, vitest]

    const { code, output, timedOut } = await runBounded(cmd, args, {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: os.homedir(),
        TMPDIR: tmp,
        NODE_ENV: 'test',
        CI: '1',
        FORCE_COLOR: '0',
      },
      timeoutMs: opts.timeoutMs ?? 120_000,
    })

    let summary: string
    let ok = code === 0 && !timedOut
    if (timedOut) {
      summary = `timed out after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s`
    } else if (fs.existsSync(report)) {
      const r = JSON.parse(fs.readFileSync(report, 'utf8')) as {
        numPassedTests: number
        numFailedTests: number
        numTotalTests: number
      }
      summary = `${r.numPassedTests}/${r.numTotalTests} passed`
      if (r.numFailedTests > 0) summary += `, ${r.numFailedTests} failed`
      ok = ok && r.numFailedTests === 0
    } else {
      summary = `runner exited with code ${code}`
    }
    if (!sandboxed) summary += ' (unsandboxed: sandbox-exec unavailable)'
    return { ran: true, ok, sandboxed, summary, log: output, durationMs: Date.now() - started }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/**
 * A real node_modules dir whose entries link to the repo's packages: imports
 * resolve as usual, while tool caches (.vite-temp) land inside the sandbox's
 * writable work dir instead of the repo.
 */
function linkNodeModules(src: string, dest: string): void {
  fs.mkdirSync(dest)
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith('.')) continue
    fs.symlinkSync(path.join(src, name), path.join(dest, name))
  }
}

function runBounded(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true })
    let output = ''
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-LOG_LIMIT)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL') // the whole process group
      } catch {
        child.kill('SIGKILL')
      }
    }, opts.timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}
