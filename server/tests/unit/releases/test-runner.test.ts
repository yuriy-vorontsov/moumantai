/**
 * Sandboxed app-test runner: results are reported, and a hostile test cannot
 * write outside its temp dir, reach the network or read denied paths.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAppTests } from '../../../src/server/releases/test-runner.js'

const repoRoot = path.resolve(__dirname, '../../../..')
const sandboxAvailable = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')

let root: string
let secretDir: string
const homeMarker = path.join(os.homedir(), `.mutabl-sandbox-probe-${process.pid}`)

function makeApp(name: string, testBody: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1\n')
  fs.writeFileSync(path.join(dir, 'tests', 'app.test.ts'), testBody)
  return dir
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-apps-'))
  secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-secret-'))
  fs.writeFileSync(path.join(secretDir, '.env'), 'ANTHROPIC_API_KEY=sk-test-not-real\n')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(secretDir, { recursive: true, force: true })
  fs.rmSync(homeMarker, { force: true })
})

describe('runAppTests', () => {
  it('reports no tests as a pass without running anything', async () => {
    const dir = path.join(root, 'empty')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'index.ts'), '')
    const r = await runAppTests({ appDir: dir, appId: 'empty', repoRoot, denyRead: [] })
    expect(r).toMatchObject({ ran: false, ok: true, summary: 'no tests' })
  })

  it('reports passing and failing tests', async () => {
    const dir = makeApp(
      'mixed',
      `import { it, expect } from 'vitest'
it('passes', () => expect(1).toBe(1))
it('fails', () => expect(1).toBe(2))
`,
    )
    const r = await runAppTests({ appDir: dir, appId: 'mixed', repoRoot, denyRead: [] })
    expect(r.ran).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('1/2 passed, 1 failed')
  }, 60_000)

  it.runIf(sandboxAvailable)(
    'contains a hostile test: no home writes, no network, no denied reads, no credentials',
    async () => {
      const dir = makeApp(
        'hostile',
        `import { it, expect } from 'vitest'
import fs from 'node:fs'
it('cannot write outside its temp dir', () => {
  expect(() => fs.writeFileSync(${JSON.stringify(homeMarker)}, 'x')).toThrow()
})
it('cannot reach the network', async () => {
  await expect(fetch('https://example.com')).rejects.toThrow()
})
it('cannot read denied paths', () => {
  expect(() => fs.readFileSync(${JSON.stringify(path.join(secretDir, '.env'))}, 'utf8')).toThrow()
})
it('sees no credentials in the environment', () => {
  expect(process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
})
`,
      )
      const prev = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = 'sk-test-parent-env'
      try {
        const r = await runAppTests({
          appDir: dir,
          appId: 'hostile',
          repoRoot,
          denyRead: [secretDir],
        })
        expect(r, r.log).toMatchObject({
          ran: true,
          ok: true,
          sandboxed: true,
          summary: '4/4 passed',
        })
        expect(fs.existsSync(homeMarker)).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = prev
      }
    },
    60_000,
  )
})
