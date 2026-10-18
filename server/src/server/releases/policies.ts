/**
 * Release policies (mutabl spec §5.2, §7.3, §7.5): pure checks over a draft
 * versus the active release. Each returns human-readable problems; an empty
 * list means the check passed.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AppManifest } from '../framework/app-types.js'
import type { ToolSchema } from '../agent/types.js'
import { compareVersions, parseVersion } from './semver.js'
import { listReleaseFiles } from './hash.js'

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function checkManifest(opts: {
  draft: AppManifest
  /** Active release manifest; null for a brand-new app. */
  active: AppManifest | null
  engineVersion: string
}): string[] {
  const { draft, active, engineVersion } = opts
  const problems: string[] = []
  const v = parseVersion(draft.version)
  if (!v) problems.push(`manifest.version "${draft.version}" is not MAJOR.MINOR.PATCH`)
  if (active) {
    if (draft.id !== active.id) {
      problems.push(
        `manifest.id changed from "${active.id}" to "${draft.id}" — an edit cannot rename the app`,
      )
    }
    const av = parseVersion(active.version)
    if (v && av && compareVersions(v, av) <= 0) {
      problems.push(
        `manifest.version ${draft.version} must be greater than the active release ${active.version} — bump it (e.g. ${av[0]}.${av[1] + 1}.0)`,
      )
    }
  }
  if (draft.moumantaiMinVersion) {
    const min = parseVersion(draft.moumantaiMinVersion)
    const engine = parseVersion(engineVersion)
    if (!min) {
      problems.push(
        `manifest.moumantaiMinVersion "${draft.moumantaiMinVersion}" is not a valid version`,
      )
    } else if (engine && compareVersions(min, engine) > 0) {
      problems.push(
        `incompatible: the app requires Moumantai >= ${draft.moumantaiMinVersion}; this server is ${engineVersion}`,
      )
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export interface MigrationEntry {
  tag: string
  sql: string
}

/** Read a drizzle migrations folder (journal order). Missing folder → []. */
export function readMigrations(folder: string | undefined | null): MigrationEntry[] {
  if (!folder) return []
  const journalPath = path.join(folder, 'meta', '_journal.json')
  if (!fs.existsSync(journalPath)) return []
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[]
  }
  return journal.entries.map((e) => ({
    tag: e.tag,
    sql: fs.readFileSync(path.join(folder, `${e.tag}.sql`), 'utf8'),
  }))
}

const STATEMENT_ADDITIVE = [
  /^create\s+table\s+(if\s+not\s+exists\s+)?(?![`"]?__new_)/i,
  /^create\s+(unique\s+)?index\b/i,
  /^insert\s+into\b/i,
  /^update\b/i,
]

/**
 * Classify one migration's SQL. Additive = old application code keeps working
 * on the migrated schema, so the previous release stays restorable.
 */
export function classifyMigrationSql(sql: string): string[] {
  const problems: string[] = []
  const statements = sql
    .split(/-->\s*statement-breakpoint|;/i)
    .map((s) => s.replace(/--[^\n]*$/gm, '').trim())
    .filter(Boolean)
  for (const stmt of statements) {
    const oneLine = stmt.replace(/\s+/g, ' ')
    if (/^alter\s+table\s+\S+\s+add\s+(column\s+)?/i.test(oneLine)) {
      if (/\bnot\s+null\b/i.test(oneLine) && !/\bdefault\b/i.test(oneLine)) {
        problems.push(`"${oneLine.slice(0, 80)}" adds a NOT NULL column without DEFAULT`)
      }
      continue
    }
    if (STATEMENT_ADDITIVE.some((re) => re.test(oneLine))) continue
    problems.push(
      `"${oneLine.slice(0, 80)}" is not backward-compatible (only additive changes are allowed)`,
    )
  }
  return problems
}

export interface MigrationPlan {
  /** Tags added by the draft, in order. */
  added: string[]
  additive: boolean
}

/**
 * Compare the draft's migrations with the active release's: released
 * migrations must be unchanged and in order; new ones must be additive.
 */
export function checkMigrations(
  draft: MigrationEntry[],
  active: MigrationEntry[],
): { problems: string[]; plan: MigrationPlan } {
  const problems: string[] = []
  active.forEach((a, i) => {
    const d = draft[i]
    if (!d || d.tag !== a.tag) problems.push(`released migration ${a.tag} was removed or reordered`)
    else if (d.sql !== a.sql) problems.push(`released migration ${a.tag} was modified`)
  })
  const added = draft.slice(active.length)
  for (const m of added) {
    for (const p of classifyMigrationSql(m.sql)) problems.push(`${m.tag}: ${p}`)
  }
  return {
    problems,
    plan: { added: added.map((m) => m.tag), additive: problems.length === 0 },
  }
}

// ---------------------------------------------------------------------------
// Dependencies / imports
// ---------------------------------------------------------------------------

const ALLOWED_IMPORTS = [/^\.{1,2}\//, /^moumantai(\/ui)?$/, /^drizzle-orm(\/.*)?$/]
const IMPORT_RE =
  /\b(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm

/** Module specifiers imported by an app's runtime code (tests excluded). */
export function runtimeImports(dir: string): Set<string> {
  const out = new Set<string>()
  for (const rel of listReleaseFiles(dir)) {
    if (!/\.(ts|js|mjs)$/.test(rel) || rel.startsWith('tests/') || rel.includes('.test.')) continue
    const text = fs.readFileSync(path.join(dir, rel), 'utf8')
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (spec) out.add(spec)
    }
  }
  return out
}

/**
 * Drafts cannot add dependencies: no package manifests/lockfiles, and runtime
 * code may import only the SDK, drizzle and relative files — plus whatever
 * the active release already imports (reviewed when it was published).
 */
export function checkDependencies(draftDir: string, activeDir: string | null): string[] {
  const problems: string[] = []
  for (const rel of listReleaseFiles(draftDir)) {
    const base = path.posix.basename(rel)
    if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(base)) {
      problems.push(`${rel}: drafts cannot add package manifests or lockfiles`)
    }
  }
  const already = activeDir ? runtimeImports(activeDir) : new Set<string>()
  for (const spec of runtimeImports(draftDir)) {
    if (ALLOWED_IMPORTS.some((re) => re.test(spec)) || already.has(spec)) continue
    problems.push(
      `import "${spec}" is not allowed in app code (SDK, drizzle and relative files only)`,
    )
  }
  return problems
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

export interface ToolDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

const RESERVED_TOOL = /^(view_|mcp__)|^request_app_change$/

function signature(t: ToolSchema): string {
  return JSON.stringify({ d: t.description, p: t.parameters })
}

/** Tool surface change (spec §7.4 "tool permission diff") + reserved-name check. */
export function diffTools(
  draft: ToolSchema[],
  active: ToolSchema[],
): { diff: ToolDiff; problems: string[] } {
  const before = new Map(active.map((t) => [t.name, t]))
  const after = new Map(draft.map((t) => [t.name, t]))
  const diff: ToolDiff = {
    added: [...after.keys()].filter((n) => !before.has(n)).sort(),
    removed: [...before.keys()].filter((n) => !after.has(n)).sort(),
    changed: [...after.keys()]
      .filter((n) => before.has(n) && signature(after.get(n)!) !== signature(before.get(n)!))
      .sort(),
  }
  const problems = draft
    .filter((t) => RESERVED_TOOL.test(t.name))
    .map((t) => `tool name "${t.name}" is reserved by the framework`)
  return { diff, problems }
}
