/**
 * Adversarial inputs for the edit-agent policy (mutabl Phase 0 probe cases,
 * docs/audit/probes/edit-policy-probe.mts). Real filesystem so symlink escapes
 * and realpath containment are exercised; DNS is injected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePathPolicy, isBlockedFetchHost } from '../../../src/server/agent/edit-session.js'

let home: string
let draftDir: string
let appsSrcDir: string
let linkedAppDir: string
let decide: (tool: string, input: Record<string, unknown>) => Promise<string>

const dns: Record<string, string[]> = {
  'example.com': ['93.184.216.34'],
  'localtest.me': ['127.0.0.1'],
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-policy-'))
  appsSrcDir = path.join(home, 'apps-src')
  draftDir = path.join(home, 'apps-drafts', 'd1')
  fs.mkdirSync(path.join(appsSrcDir, 'todo'), { recursive: true })
  fs.mkdirSync(path.join(draftDir, '.shadow'), { recursive: true })
  fs.mkdirSync(path.join(home, 'apps', 'todo'), { recursive: true })
  fs.writeFileSync(path.join(home, '.env'), 'X=1\n')
  fs.writeFileSync(path.join(draftDir, 'index.ts'), '')
  fs.writeFileSync(path.join(draftDir, '.shadow', 'db.sqlite'), '')
  fs.symlinkSync(home, path.join(draftDir, 'escape'))
  // Dev installs link apps-src/<id> to the repo's apps/<id> (outside home).
  linkedAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-app-'))
  fs.writeFileSync(path.join(linkedAppDir, 'index.ts'), '')
  fs.symlinkSync(linkedAppDir, path.join(appsSrcDir, 'linked'))
  const policy = makePathPolicy(draftDir, appsSrcDir, {
    lookup: async (host) => {
      const a = dns[host]
      if (!a) throw new Error('ENOTFOUND')
      return a
    },
  })
  const signal = new AbortController().signal
  decide = async (tool, input) => (await policy(tool, input, { signal })).behavior
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(linkedAppDir, { recursive: true, force: true })
})

describe('Bash', () => {
  it.each([
    'ls -la',
    'ls faces',
    'node --version',
    'cat index.ts',
    'head -n 20 index.ts',
    'grep -rn "defineFace" .',
    'grep -rn -e "x|y" index.ts',
    'sqlite3 -readonly .shadow/db.sqlite ".schema tasks"',
    'sqlite3 -readonly .shadow/db.sqlite "SELECT count(*) FROM tasks WHERE a > 1"',
    "grep -rn 'export function\\|export const' .",
    "find . -name '*.ts' -type f",
    'find faces -maxdepth 2',
  ])('allows %s', async (command) => {
    expect(await decide('Bash', { command })).toBe('allow')
  })

  it.each([
    ['cat index.ts; touch /tmp/p', 'chaining ;'],
    ['ls && curl https://example.com', 'chaining &&'],
    ['ls | sh', 'pipe'],
    ['cat $(echo index.ts)', 'substitution'],
    ['cat `echo index.ts`', 'backticks'],
    ['cat index.ts > out.txt', 'redirection'],
    ['task validate', 'agent-writable Taskfile'],
    ['cat ../../.env', 'traversal'],
    ['cat escape/.env', 'symlink escape'],
    ['grep -r ANTHROPIC /', 'filesystem-wide grep'],
    ['grep -f /etc/passwd index.ts', 'grep pattern file'],
    ['sqlite3 -readonly ../../apps/todo/db.sqlite "SELECT 1"', 'live DB'],
    ['sqlite3 -readonly .shadow/db.sqlite ".shell ls"', 'sqlite .shell'],
    ['sqlite3 -readonly .shadow/db.sqlite "SELECT writefile(\'/tmp/x\', 1)"', 'writefile'],
    ['sqlite3 -readonly .shadow/db.sqlite "ATTACH \'/tmp/x\' AS y"', 'attach'],
    ['sqlite3 .shadow/db.sqlite "SELECT 1"', 'not read-only'],
    ['echo hi', 'not allowlisted'],
    ['node -e "require(1)"', 'node eval'],
    ['grep "a\\" " ; rm -rf ~ ; " index.ts', 'escaped quote desync'],
    ['grep -r "a\\|b" .', 'backslash in double quotes'],
    ['find . -delete', 'find -delete'],
    ['find . -name x -exec rm {} +', 'find -exec'],
    ['find / -name .env', 'find outside roots'],
  ])('denies %s (%s)', async (command) => {
    expect(await decide('Bash', { command })).toBe('deny')
  })
})

describe('Read / Write containment', () => {
  it('denies reads and writes through a symlink that leaves the draft', async () => {
    expect(await decide('Read', { file_path: path.join(draftDir, 'escape', '.env') })).toBe('deny')
    expect(
      await decide('Write', {
        file_path: path.join(draftDir, 'escape', 'apps-src', 'todo', 'index.ts'),
      }),
    ).toBe('deny')
  })

  it('reads a symlinked installed app (apps-src/<id> → repo) as live source', async () => {
    expect(await decide('Read', { file_path: path.join(appsSrcDir, 'linked', 'index.ts') })).toBe(
      'allow',
    )
    expect(await decide('Bash', { command: `ls ${path.join(appsSrcDir, 'linked')}` })).toBe('allow')
    expect(await decide('Write', { file_path: path.join(appsSrcDir, 'linked', 'index.ts') })).toBe(
      'deny',
    )
  })

  it('allows writing a new file inside the draft and reading live source', async () => {
    expect(await decide('Write', { file_path: path.join(draftDir, 'faces', 'new.ts') })).toBe(
      'allow',
    )
    expect(await decide('Read', { file_path: path.join(appsSrcDir, 'todo', 'index.ts') })).toBe(
      'allow',
    )
  })
})

describe('default deny', () => {
  it.each(['NotebookEdit', 'mcp__other__anything', 'Task', 'KillShell'])(
    'denies unlisted tool %s',
    async (tool) => {
      expect(await decide(tool, {})).toBe('deny')
    },
  )

  it.each(['TodoWrite', 'Skill', 'ToolSearch', 'mcp__edit__validate_face'])(
    'allows %s',
    async (tool) => {
      expect(await decide(tool, {})).toBe('allow')
    },
  )
})

describe('WebFetch SSRF guard', () => {
  it.each([
    'http://[::ffff:127.0.0.1]:3000/',
    'http://100.100.100.100/',
    'http://198.18.0.1/',
    'http://localtest.me:3000/',
    'http://no-such-host.invalid/',
  ])('denies %s', async (url) => {
    expect(await decide('WebFetch', { url })).toBe('deny')
  })

  it('allows a public host', async () => {
    expect(await decide('WebFetch', { url: 'https://example.com/' })).toBe('allow')
  })

  it('classifies literal hosts', () => {
    expect(isBlockedFetchHost('::ffff:7f00:1')).toBe(true)
    expect(isBlockedFetchHost('100.64.0.1')).toBe(true)
    expect(isBlockedFetchHost('8.8.8.8')).toBe(false)
  })
})
