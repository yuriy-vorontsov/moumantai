/**
 * Platform-DB tables for the release workflow (mutabl spec §7): immutable
 * releases, validation runs, owner approvals and a lifecycle event log.
 * Migration: `drizzle/platform/0016_releases.sql`.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { id } from '../db/conventions.js'

const createdAt = () => ({
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
})

/** One immutable, content-addressed release of an app. Exactly one is active per app. */
export const releases = sqliteTable(
  'releases',
  {
    ...id(),
    appId: text('app_id').notNull(),
    version: text('version').notNull(),
    /** SHA-256 over the release's files (see hash.ts). Re-verified before activation. */
    contentHash: text('content_hash').notNull(),
    /** Last migration tag the release ships (null = no migrations). */
    schemaTag: text('schema_tag'),
    status: text('status', { enum: ['active', 'superseded'] }).notNull(),
    /** 'baseline' = live source captured before the first publish. */
    source: text('source', { enum: ['baseline', 'draft'] }).notNull(),
    draftId: text('draft_id'),
    approvalId: text('approval_id'),
    validationRunId: text('validation_run_id'),
    artifactDir: text('artifact_dir').notNull(),
    /** JSON: { migrations: string[], additive: boolean } applied when this release was published. */
    migrationPlan: text('migration_plan'),
    /** Live DB backup taken before this release's migrations. */
    dbBackup: text('db_backup'),
    ...createdAt(),
    activatedAt: text('activated_at'),
  },
  (t) => [index('releases_app_idx').on(t.appId, t.createdAt)],
)

/** Result of one validation pipeline run over a draft's exact content. */
export const validationRuns = sqliteTable(
  'validation_runs',
  {
    ...id(),
    draftId: text('draft_id').notNull(),
    appId: text('app_id').notNull(),
    contentHash: text('content_hash').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    /** JSON array of ValidationStep. */
    steps: text('steps').notNull(),
    ...createdAt(),
  },
  (t) => [index('validation_runs_draft_idx').on(t.draftId, t.createdAt)],
)

/** Owner decision on a draft, bound to the content it saw. */
export const approvals = sqliteTable('approvals', {
  ...id(),
  /** Device id of the approving principal ('cli' for the owner's terminal). */
  principal: text('principal').notNull(),
  /** 'draft:<draftId>' | 'release:<releaseId>' */
  target: text('target').notNull(),
  contentHash: text('content_hash'),
  decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
  ...createdAt(),
})

/** Append-only state history for drafts and releases (spec §7.1). */
export const lifecycleEvents = sqliteTable(
  'lifecycle_events',
  {
    ...id(),
    subjectType: text('subject_type', { enum: ['draft', 'release'] }).notNull(),
    subjectId: text('subject_id').notNull(),
    appId: text('app_id').notNull(),
    state: text('state').notNull(),
    /** Device id, 'agent', 'cli' or 'system'. */
    actor: text('actor').notNull(),
    detail: text('detail'),
    ...createdAt(),
  },
  (t) => [index('lifecycle_events_subject_idx').on(t.subjectType, t.subjectId)],
)

export type Release = typeof releases.$inferSelect
export type ValidationRunRow = typeof validationRuns.$inferSelect
export type LifecycleEvent = typeof lifecycleEvents.$inferSelect
