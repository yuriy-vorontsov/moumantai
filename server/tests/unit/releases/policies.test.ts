import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions, parseVersion, satisfies } from '../../../src/server/releases/semver.js'
import {
  contentHash,
  copyReleaseFiles,
  listReleaseFiles,
} from '../../../src/server/releases/hash.js'
import {
  checkDependencies,
  checkManifest,
  checkMigrations,
  classifyMigrationSql,
  diffTools,
} from '../../../src/server/releases/policies.js'

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'todo',
  version: '0.3.0',
  name: 'Todo',
  icon: 'x',
  description: '',
  ...over,
})

describe('semver', () => {
  it('parses and compares', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.2')).toBeNull()
    expect(compareVersions([0, 3, 0], [0, 2, 9])).toBe(1)
  })
  it.each([
    ['0.1.5', '^0.1.0', true],
    ['0.2.0', '^0.1.0', false],
    ['1.4.0', '^1.2.0', true],
    ['0.1.0', '>=0.1.0 <1.0.0', true],
    ['2.0.0', '>=0.1.0 <1.0.0', false],
    ['0.1.9', '~0.1.0', true],
    ['0.1.0', 'nonsense', null],
  ])('%s satisfies %s → %s', (v, r, expected) => {
    expect(satisfies(v, r)).toBe(expected)
  })
})

describe('checkManifest', () => {
  const active = manifest({ version: '0.2.0' })
  it('accepts a bumped version', () => {
    expect(checkManifest({ draft: manifest(), active, engineVersion: '0.1.0' })).toEqual([])
  })
  it('requires a version bump', () => {
    expect(
      checkManifest({ draft: manifest({ version: '0.2.0' }), active, engineVersion: '0.1.0' })[0],
    ).toContain('must be greater than the active release 0.2.0')
  })
  it('rejects renaming the app', () => {
    expect(
      checkManifest({ draft: manifest({ id: 'tasks' }), active, engineVersion: '0.1.0' })[0],
    ).toContain('cannot rename')
  })
  it('rejects a manifest that needs a newer engine (AT-20)', () => {
    expect(
      checkManifest({
        draft: manifest({ moumantaiMinVersion: '9.0.0' }),
        active,
        engineVersion: '0.1.0',
      })[0],
    ).toBe('incompatible: the app requires Moumantai >= 9.0.0; this server is 0.1.0')
  })
})

describe('migrations', () => {
  it.each([
    'CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL)',
    'CREATE UNIQUE INDEX `x` ON `projects` (`name`)',
    'ALTER TABLE `tasks` ADD `project_id` text',
    "ALTER TABLE `tasks` ADD `kind` text DEFAULT 'a' NOT NULL",
    "UPDATE `tasks` SET `kind` = 'b'",
  ])('additive: %s', (sql) => {
    expect(classifyMigrationSql(sql)).toEqual([])
  })
  it.each([
    'ALTER TABLE `tasks` DROP COLUMN `notes`',
    'DROP TABLE `tasks`',
    'ALTER TABLE `tasks` RENAME COLUMN `notes` TO `body`',
    'ALTER TABLE `tasks` ADD `kind` text NOT NULL',
    'CREATE TABLE `__new_tasks` (`id` text)',
    'PRAGMA foreign_keys=OFF',
    'DELETE FROM `tasks`',
  ])('not backward-compatible: %s', (sql) => {
    expect(classifyMigrationSql(sql)).toHaveLength(1)
  })
  it('requires released migrations to stay as they were', () => {
    const active = [{ tag: '0000_a', sql: 'CREATE TABLE t (id text)' }]
    expect(
      checkMigrations([{ tag: '0000_a', sql: 'CREATE TABLE t (x text)' }], active).problems[0],
    ).toContain('was modified')
    const ok = checkMigrations(
      [...active, { tag: '0001_b', sql: 'ALTER TABLE t ADD c text' }],
      active,
    )
    expect(ok).toEqual({ problems: [], plan: { added: ['0001_b'], additive: true } })
  })
})

describe('files, hash and dependencies', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-files-'))
    fs.mkdirSync(path.join(dir, 'faces'))
    fs.mkdirSync(path.join(dir, '.shadow'))
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.ts'), "import { a } from './faces/a.js'\n")
    fs.writeFileSync(path.join(dir, 'faces', 'a.ts'), "import { eq } from 'drizzle-orm'\n")
    fs.writeFileSync(path.join(dir, '.shadow', 'db.sqlite'), 'x')
    fs.writeFileSync(path.join(dir, '.meta.json'), '{}')
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('lists only release files and hashes their content', () => {
    expect(listReleaseFiles(dir)).toEqual(['faces/a.ts', 'index.ts'])
    const before = contentHash(dir)
    fs.writeFileSync(path.join(dir, '.meta.json'), '{"changed":true}')
    expect(contentHash(dir)).toBe(before) // ephemerals don't count
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'release-copy-'))
    copyReleaseFiles(dir, copy)
    expect(contentHash(copy)).toBe(before)
  })

  it('rejects new runtime imports and package manifests', () => {
    expect(checkDependencies(dir, null)).toEqual([])
    fs.writeFileSync(path.join(dir, 'faces', 'b.ts'), "import { exec } from 'node:child_process'\n")
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    const problems = checkDependencies(dir, null)
    expect(problems).toContain('package.json: drafts cannot add package manifests or lockfiles')
    expect(problems.some((p) => p.includes('"node:child_process"'))).toBe(true)
  })
})

describe('diffTools', () => {
  const t = (name: string, description = 'd') => ({ name, description, parameters: {} })
  it('reports added, removed and changed tools and reserved names', () => {
    const { diff, problems } = diffTools(
      [t('add_task', 'new'), t('list_projects'), t('view_x')],
      [t('add_task'), t('delete_task')],
    )
    expect(diff).toEqual({
      added: ['list_projects', 'view_x'],
      removed: ['delete_task'],
      changed: ['add_task'],
    })
    expect(problems).toEqual(['tool name "view_x" is reserved by the framework'])
  })
})
