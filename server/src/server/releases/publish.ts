/**
 * Release filesystem operations (mutabl spec §7.5, §7.6):
 *  - immutable artifacts under `<home>/releases/<appId>/<version>-<id>/`,
 *    content-hashed and re-verified before use;
 *  - the active pointer `<home>/apps-src/<appId>`: a symlink switched
 *    atomically (symlink to a temp name, then rename over the old one);
 *  - DB backups before migrations, and the restore compatibility check.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { homeLayout } from '../workspace/home.js'
import { cloneLiveDbToShadow } from '../drafts/draft-db.js'
import { contentHash, copyReleaseFiles } from './hash.js'
import type { Release } from './schema.js'
import type { ReleaseStore } from './store.js'
import type { MigrationPlan } from './policies.js'

export function releasesDir(home: string, appId: string): string {
  return path.join(home, 'releases', appId)
}

export function backupsDir(home: string, appId: string): string {
  return path.join(home, 'backups', appId)
}

/** The active pointer: `<home>/apps-src/<appId>`. */
export function pointerPath(home: string, appId: string): string {
  return path.join(homeLayout(home).appsSrcDir, appId)
}

/**
 * True when `appDir` is a release pointer (a symlink into `<home>/releases`).
 * Such apps are immutable: only publish/restore activate them, with a fresh
 * bundle — a file-watcher reload would re-import stale cached modules.
 */
export function isReleaseManaged(home: string, appDir: string): boolean {
  try {
    if (!fs.lstatSync(appDir).isSymbolicLink()) return false
    const root = path.join(home, 'releases')
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root
    return fs.realpathSync(appDir).startsWith(realRoot + path.sep)
  } catch {
    return false
  }
}

/** Copy `srcDir`'s release files into a new artifact; returns its dir + hash. */
export function createArtifact(
  home: string,
  appId: string,
  version: string,
  srcDir: string,
): { artifactDir: string; contentHash: string } {
  const dir = path.join(releasesDir(home, appId), `${version}-${crypto.randomUUID().slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  copyReleaseFiles(srcDir, dir)
  return { artifactDir: dir, contentHash: contentHash(dir) }
}

/** Throw if an artifact no longer matches the hash recorded at publish time. */
export function verifyArtifact(release: Release): void {
  if (!fs.existsSync(release.artifactDir)) {
    throw new Error(`release ${release.version} artifact is missing (${release.artifactDir})`)
  }
  const actual = contentHash(release.artifactDir)
  if (actual !== release.contentHash) {
    throw new Error(
      `release ${release.version} artifact was modified after publication (hash mismatch)`,
    )
  }
}

/**
 * Atomically point `<home>/apps-src/<appId>` at `target`. Returns the previous
 * target (symlink destination, or where a pre-release real directory was moved)
 * so a failed activation can be rolled back; null when there was none.
 */
export function switchPointer(home: string, appId: string, target: string): string | null {
  const link = pointerPath(home, appId)
  const staging = releasesDir(home, appId)
  fs.mkdirSync(staging, { recursive: true })
  let previous: string | null = null
  let stat: fs.Stats | null = null
  try {
    stat = fs.lstatSync(link)
  } catch {
    stat = null
  }
  if (stat?.isSymbolicLink()) {
    previous = path.resolve(path.dirname(link), fs.readlinkSync(link))
  } else if (stat) {
    // A real directory (git/local install before releases existed): move it
    // out of apps-src so the pointer can become a symlink.
    previous = path.join(staging, `.source-before-releases-${Date.now()}`)
    fs.renameSync(link, previous)
  }
  fs.mkdirSync(path.dirname(link), { recursive: true })
  const tmp = path.join(staging, `.pointer-${crypto.randomUUID().slice(0, 8)}`)
  fs.symlinkSync(target, tmp)
  fs.renameSync(tmp, link) // atomic replace on POSIX
  return previous
}

/** Remove the pointer (new-app publish that failed to activate). */
export function removePointer(home: string, appId: string): void {
  fs.rmSync(pointerPath(home, appId), { force: true })
}

/** VACUUM INTO a timestamped backup; returns its path (null when there is no DB yet). */
export function backupDatabase(
  home: string,
  appId: string,
  liveDbPath: string,
  label: string,
): string | null {
  if (!fs.existsSync(liveDbPath)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(backupsDir(home, appId), `${stamp}-before-${label}.sqlite`)
  cloneLiveDbToShadow(liveDbPath, dest)
  return dest
}

/**
 * The release that is live before the first publish: capture the current
 * source as an immutable `baseline` release so it can always be restored.
 */
export function ensureBaseline(opts: {
  home: string
  appId: string
  version: string
  schemaTag: string | null
  store: ReleaseStore
}): Release {
  const existing = opts.store.active(opts.appId)
  if (existing) return existing
  const live = fs.realpathSync(pointerPath(opts.home, opts.appId))
  const { artifactDir, contentHash: hash } = createArtifact(
    opts.home,
    opts.appId,
    opts.version,
    live,
  )
  const release = opts.store.insert({
    appId: opts.appId,
    version: opts.version,
    contentHash: hash,
    schemaTag: opts.schemaTag,
    source: 'baseline',
    artifactDir,
  })
  opts.store.markActive(opts.appId, release.id)
  switchPointer(opts.home, opts.appId, artifactDir)
  opts.store.event({
    subjectType: 'release',
    subjectId: release.id,
    appId: opts.appId,
    state: 'ACTIVATED',
    actor: 'system',
    detail: `baseline ${opts.version} captured from ${live}`,
  })
  return opts.store.get(release.id)!
}

// ---------------------------------------------------------------------------
// Restore compatibility (spec §7.6)
// ---------------------------------------------------------------------------

/** Journal timestamps (`when`) of the migrations shipped in a release artifact. */
function releaseMigrationWhens(artifactDir: string): Map<number, string> {
  const journal = path.join(artifactDir, 'drizzle', 'meta', '_journal.json')
  if (!fs.existsSync(journal)) return new Map()
  const entries = (
    JSON.parse(fs.readFileSync(journal, 'utf8')) as { entries: { when: number; tag: string }[] }
  ).entries
  return new Map(entries.map((e) => [e.when, e.tag]))
}

/** `created_at` (= journal `when`) of every migration applied to a DB. */
function appliedMigrationWhens(dbPath: string): number[] {
  if (!fs.existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.prepare(`SELECT created_at AS w FROM __drizzle_migrations`).all() as {
      w: number
    }[]
    return rows.map((r) => Number(r.w))
  } catch {
    return []
  } finally {
    db.close()
  }
}

/**
 * Null when `target` can run on the live data; otherwise a clear reason.
 * Compatible = every migration the target ships is applied, and every
 * migration applied since then came from a release whose plan was additive.
 */
export function restoreIncompatibility(opts: {
  target: Release
  liveDbPath: string
  allReleases: Release[]
}): string | null {
  const shipped = releaseMigrationWhens(opts.target.artifactDir)
  const applied = appliedMigrationWhens(opts.liveDbPath)
  const missing = [...shipped.keys()].filter((w) => !applied.includes(w))
  if (missing.length > 0) {
    return `release ${opts.target.version} expects migrations that are not applied to the live data (${missing.map((w) => shipped.get(w)).join(', ')})`
  }
  const additiveTags = new Set<string>()
  for (const r of opts.allReleases) {
    if (!r.migrationPlan) continue
    const plan = JSON.parse(r.migrationPlan) as MigrationPlan
    if (plan.additive) plan.added.forEach((t) => additiveTags.add(t))
  }
  const knownTags = new Map<number, string>()
  for (const r of opts.allReleases) {
    for (const [w, tag] of releaseMigrationWhens(r.artifactDir)) knownTags.set(w, tag)
  }
  for (const w of applied) {
    if (shipped.has(w)) continue
    const tag = knownTags.get(w)
    if (!tag || !additiveTags.has(tag)) {
      return `release ${opts.target.version} is not compatible with the current data: migration ${tag ?? `@${w}`} was applied after it and is not known to be backward-compatible`
    }
  }
  return null
}
