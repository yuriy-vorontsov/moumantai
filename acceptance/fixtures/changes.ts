/**
 * Recorded Developer Agent output for the Phase 3 acceptance tests: the
 * changes a real edit-agent made (AT-05 probe, docs/audit in mutabl), applied
 * deterministically to a draft worktree. The live run with the real agent is
 * documented separately; these keep the gate reproducible offline.
 */

import fs from 'node:fs'
import path from 'node:path'

const CALENDAR = path.resolve(__dirname, 'calendar-change')

function edit(file: string, from: string | RegExp, to: string): void {
  const before = fs.readFileSync(file, 'utf8')
  const after = before.replace(from, to)
  if (after === before) throw new Error(`fixture edit did not apply to ${file}: ${String(from)}`)
  fs.writeFileSync(file, after)
}

/** Bump manifest.version (and the registration test that pins it). */
export function bumpVersion(dir: string, from: string, to: string): void {
  edit(path.join(dir, 'manifest.ts'), `version: '${from}'`, `version: '${to}'`)
  edit(path.join(dir, 'tests', 'todo.test.ts'), `toBe('${from}')`, `toBe('${to}')`)
}

/** AT-05: a Calendar face (tasks of the next 14 days by date) + its test. */
export function addCalendarFace(dir: string, opts: { bump?: boolean } = {}): void {
  fs.cpSync(CALENDAR, dir, { recursive: true })
  edit(
    path.join(dir, 'index.ts'),
    "import projectsFace from './faces/projects/projects.compact.js'",
    "import projectsFace from './faces/projects/projects.compact.js'\nimport calendarFace from './faces/calendar/calendar.compact.js'",
  )
  edit(
    path.join(dir, 'index.ts'),
    'composeFace, projectsFace]',
    'composeFace, projectsFace, calendarFace]',
  )
  edit(
    path.join(dir, 'tests', 'todo.test.ts'),
    "['today', 'upcoming', 'inbox', 'compose', 'projects']",
    "['today', 'upcoming', 'inbox', 'compose', 'projects', 'calendar']",
  )
  if (opts.bump ?? true) bumpVersion(dir, '0.2.0', '0.3.0')
}

/** AT-09: a test that fails. */
export function addFailingTest(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'tests', 'broken.test.ts'),
    `import { it, expect } from 'vitest'\n\nit('calendar shows weekends', () => {\n  expect(['Mon', 'Tue']).toContain('Sat')\n})\n`,
  )
}

/** AT-20: a manifest that needs a newer Moumantai than this server. */
export function requireEngine(dir: string, version: string): void {
  edit(
    path.join(dir, 'manifest.ts'),
    "icon: 'check_circle',",
    `icon: 'check_circle',\n  moumantaiMinVersion: '${version}',`,
  )
}

/** AT-20: a destructive migration (drops a column live data uses). */
export function addDestructiveMigration(dir: string): void {
  const drizzle = path.join(dir, 'drizzle')
  fs.writeFileSync(
    path.join(drizzle, '0002_drop_notes.sql'),
    'ALTER TABLE `tasks` DROP COLUMN `notes`;\n',
  )
  const journalFile = path.join(drizzle, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  journal.entries.push({
    idx: 2,
    version: '6',
    when: 1792300000000,
    tag: '0002_drop_notes',
    breakpoints: true,
  })
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2))
}
