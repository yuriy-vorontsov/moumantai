/**
 * Promote = publish a draft as an immutable release (mutabl spec §7.5).
 *
 * EDIT draft:
 *   1. APPROVE   — record the owner's approval bound to the draft content hash.
 *   2. VALIDATE  — reuse a passing validation run for exactly this content, or
 *                  run the pipeline now. Failure blocks publication.
 *   3. BASELINE  — first publish only: capture the current live source as a
 *                  restorable `baseline` release.
 *   4. ARTIFACT  — copy the draft into `<home>/releases/<app>/<version>-<id>`;
 *                  its hash must equal the validated hash.
 *   5. PRE-FLIGHT— run migrations on a throwaway clone of live data.
 *   6. BACKUP + MIGRATE the live DB (forward-only, additive by policy).
 *   7. SWITCH    — atomically point `apps-src/<app>` at the artifact, ACTIVATE.
 *                  On activation failure, point back and re-activate.
 *   8. RECORD    — release active, lifecycle events, promotions row; cleanup.
 *
 * NEW-APP draft: steps 3 and 5–6 are skipped; a manifest.id collision check
 * runs instead.
 */

import fs from 'node:fs'
import path from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type Database from 'better-sqlite3'
import type { DraftRegistry } from './draft-registry.js'
import type { DraftMeta, DraftActionOutcome } from './types.js'
import { cloneLiveDbToShadow } from './draft-db.js'
import { removeDraftWorktree, removeTmpPath } from './draft-fs.js'
import { contentHash } from '../releases/hash.js'
import { readMigrations } from '../releases/policies.js'
import { formatReport, type PipelineResult } from '../releases/pipeline.js'
import type { ReleaseStore } from '../releases/store.js'
import {
  backupDatabase,
  createArtifact,
  ensureBaseline,
  pointerPath,
  removePointer,
  switchPointer,
} from '../releases/publish.js'

export interface PromoteDeps {
  home: string
  draftRegistry: DraftRegistry
  /** Live app's DB file path (edit drafts only). */
  liveDbPath: (appId: string) => string
  /** Version + migrations folder of the live app (edit drafts), for the baseline. */
  liveApp: (appId: string) => { version: string; migrationsFolder?: string } | undefined
  /** Live + other-draft app ids, excluding the given draft — new-app collision. */
  existingAppIds: (excludeDraftId: string) => Set<string>
  /** (Re-)activate the app from its pointer (edit: swap; new-app: register+boot). */
  activateLive: (appId: string, kind: 'edit' | 'new-app') => Promise<void>
  /** Persist a promotions audit row (legacy summary log). */
  recordPromotion: (p: {
    draftId: string
    appId: string
    promotedAt: string
    summary?: string
    msgCount: number
  }) => void
  releases: ReleaseStore
  /** Run the validation pipeline for this draft (recorded by promote). */
  validate: () => Promise<PipelineResult>
  /** Device id (or 'cli') of the approving owner. */
  principal: string
  /** Injected clock — avoids Date in hot paths and keeps promote testable. */
  now: () => Date
}

function migrateInPlace(dbPath: string, migrationsFolder: string): void {
  const db = drizzle({ connection: dbPath, casing: 'snake_case' })
  try {
    migrate(db, { migrationsFolder })
  } finally {
    ;(db as unknown as { $client: Database.Database }).$client.close()
  }
}

function lastTag(folder: string | undefined): string | null {
  const m = readMigrations(folder)
  return m.length ? m[m.length - 1]!.tag : null
}

/**
 * Promote `draftId`. Returns a structured outcome (never throws for expected
 * failure modes — validation, pre-flight, collision, rollback). The caller
 * holds the per-draft promote lock and maps the outcome to the wire ACK.
 */
export async function promoteDraft(
  deps: PromoteDeps,
  draftId: string,
  meta: DraftMeta,
): Promise<DraftActionOutcome> {
  const entry = deps.draftRegistry.get(draftId)
  if (!entry) return { ok: false, error: `draft "${draftId}" not found` }

  const finalAppId = entry.appDef.manifest.id
  const version = entry.appDef.manifest.version
  const migrationsFolder = entry.appDef.migrationsFolder
  const draftDir = entry.draftDir
  const tmpDir = path.join(deps.home, 'tmp')
  const { releases } = deps
  const event = (state: string, actor: string, detail?: string) =>
    releases.event({
      subjectType: 'draft',
      subjectId: draftId,
      appId: finalAppId,
      state,
      actor,
      ...(detail ? { detail } : {}),
    })
  const fail = (error: string): DraftActionOutcome => {
    event('FAILED', 'system', error)
    return { ok: false, error }
  }

  // 1. APPROVE (bound to what the owner saw).
  const hash = contentHash(draftDir)
  const approvalId = releases.approve({
    principal: deps.principal,
    target: `draft:${draftId}`,
    contentHash: hash,
    decision: 'approved',
  })
  event('APPROVED', deps.principal, `content ${hash.slice(0, 12)}`)

  // 2. VALIDATE (reuse a passing run for exactly this content).
  let run = releases.passingRun(draftId, hash)
  if (!run) {
    event('VALIDATING', 'system')
    const result = await deps.validate()
    run = releases.recordRun({
      draftId,
      appId: finalAppId,
      contentHash: result.contentHash,
      ok: result.ok,
      steps: result,
    })
    if (!result.ok) {
      const failed = result.steps.filter((s) => !s.ok).map((s) => s.name)
      event('VALIDATION_FAILED', 'system', failed.join(', '))
      return { ok: false, error: formatReport(result) }
    }
    if (result.contentHash !== hash) {
      return fail('The draft changed while it was being validated. Promote again.')
    }
  }
  const validated = JSON.parse(run.steps) as PipelineResult
  const migrationPlan = validated.migrationPlan ? JSON.stringify(validated.migrationPlan) : null
  event('PUBLISHING', 'system')

  // ---- NEW-APP path: no live db/source; collision-check then artifact + activate.
  if (entry.kind === 'new-app') {
    if (deps.existingAppIds(draftId).has(finalAppId)) {
      return fail(`App id "${finalAppId}" already exists. Ask the agent to rename it.`)
    }
    const artifact = createArtifact(deps.home, finalAppId, version, draftDir)
    if (artifact.contentHash !== hash) return fail('artifact does not match the validated draft')
    const release = releases.insert({
      appId: finalAppId,
      version,
      contentHash: artifact.contentHash,
      schemaTag: lastTag(migrationsFolder),
      source: 'draft',
      draftId,
      approvalId,
      validationRunId: run.id,
      artifactDir: artifact.artifactDir,
      migrationPlan,
    })
    try {
      switchPointer(deps.home, finalAppId, artifact.artifactDir)
      await deps.activateLive(finalAppId, 'new-app')
      deps.draftRegistry.unregister(draftId)
    } catch (err) {
      // Remove the partial install; the draft stays registered to fix or Discard.
      removePointer(deps.home, finalAppId)
      return fail(`Promote failed while installing new app: ${errMsg(err)}`)
    }
    return finish(deps, {
      draftId,
      draftDir,
      meta,
      appId: finalAppId,
      releaseId: release.id,
      event,
    })
  }

  // ---- EDIT path.
  const liveAppId = entry.appId
  const liveDb = deps.liveDbPath(liveAppId)
  const live = deps.liveApp(liveAppId)
  if (!live) return fail(`live app "${liveAppId}" is not booted`)
  if (!fs.existsSync(pointerPath(deps.home, liveAppId))) {
    return fail(
      `"${liveAppId}" is not installed in ${path.dirname(pointerPath(deps.home, liveAppId))}, so it cannot be published as a release. Install it there (task server:cli -- app install) and try again.`,
    )
  }

  // 3. BASELINE (first publish of this app).
  const baseline = ensureBaseline({
    home: deps.home,
    appId: liveAppId,
    version: live.version,
    schemaTag: lastTag(live.migrationsFolder),
    store: releases,
  })

  // 4. ARTIFACT.
  const artifact = createArtifact(deps.home, liveAppId, version, draftDir)
  if (artifact.contentHash !== hash) return fail('artifact does not match the validated draft')

  // 5. PRE-FLIGHT — migrate a throwaway clone of live; abort on throw.
  const migrationCheckDb = path.join(tmpDir, `promote-check-${draftId}.sqlite`)
  if (migrationsFolder) {
    try {
      cloneLiveDbToShadow(liveDb, migrationCheckDb)
      migrateInPlace(migrationCheckDb, migrationsFolder)
    } catch (err) {
      return fail(
        `Migration would fail on live data: ${errMsg(err)}. Live has changed since the draft was created — ask the agent to adjust.`,
      )
    } finally {
      removeTmpPath(migrationCheckDb)
    }
  }

  // 6. BACKUP + MIGRATE live db.
  let dbBackup: string | null = null
  try {
    if (migrationsFolder) {
      dbBackup = backupDatabase(deps.home, liveAppId, liveDb, version)
      migrateInPlace(liveDb, migrationsFolder)
    }
  } catch (err) {
    return fail(
      `Live migration failed: ${errMsg(err)}. Live source unchanged${dbBackup ? `; backup at ${dbBackup}` : ''}.`,
    )
  }

  const release = releases.insert({
    appId: liveAppId,
    version,
    contentHash: artifact.contentHash,
    schemaTag: lastTag(migrationsFolder),
    source: 'draft',
    draftId,
    approvalId,
    validationRunId: run.id,
    artifactDir: artifact.artifactDir,
    migrationPlan,
    dbBackup,
  })

  // 7. SWITCH + ACTIVATE. Unregister ONLY after activation succeeds — if it
  // throws, point back at the previous release (its code works on the
  // migrated schema: migrations are additive and validated against it).
  const previous = switchPointer(deps.home, liveAppId, artifact.artifactDir)
  try {
    await deps.activateLive(liveAppId, 'edit')
    deps.draftRegistry.unregister(draftId)
  } catch (err) {
    try {
      switchPointer(deps.home, liveAppId, previous ?? baseline.artifactDir)
      await deps.activateLive(liveAppId, 'edit')
    } catch (restoreErr) {
      return fail(
        `Promote failed (${errMsg(err)}) AND re-activation of the previous release failed (${errMsg(restoreErr)}).`,
      )
    }
    return fail(`Promote failed and the previous release is active again: ${errMsg(err)}`)
  }

  return finish(deps, { draftId, draftDir, meta, appId: liveAppId, releaseId: release.id, event })
}

/** 8. RECORD + CLEANUP after a successful activation. */
function finish(
  deps: PromoteDeps,
  done: {
    draftId: string
    draftDir: string
    meta: DraftMeta
    appId: string
    releaseId: string
    event: (state: string, actor: string, detail?: string) => void
  },
): DraftActionOutcome {
  deps.releases.markActive(done.appId, done.releaseId)
  const release = deps.releases.get(done.releaseId)!
  done.event('PUBLISHED', 'system', `release ${release.version} (${done.releaseId})`)
  deps.releases.event({
    subjectType: 'release',
    subjectId: done.releaseId,
    appId: done.appId,
    state: 'ACTIVATED',
    actor: deps.principal,
    detail: `published from draft ${done.draftId}`,
  })
  deps.recordPromotion({
    draftId: done.draftId,
    appId: done.appId,
    promotedAt: deps.now().toISOString(),
    summary: done.meta.summary,
    msgCount: done.meta.msgCount,
  })
  removeDraftWorktree(done.draftDir)
  return { ok: true }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
