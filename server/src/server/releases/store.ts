/**
 * ReleaseStore — persistence for releases, validation runs, approvals and the
 * lifecycle event log (platform.db). Pure bookkeeping: filesystem work lives
 * in publish.ts.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  approvals,
  lifecycleEvents,
  releases,
  validationRuns,
  type LifecycleEvent,
  type Release,
  type ValidationRunRow,
} from './schema.js'

export type NewRelease = Omit<typeof releases.$inferInsert, 'status' | 'activatedAt'>

export class ReleaseStore {
  constructor(private readonly db: BetterSQLite3Database<Record<string, unknown>>) {}

  // ---- releases ------------------------------------------------------------

  active(appId: string): Release | undefined {
    return this.db
      .select()
      .from(releases)
      .where(and(eq(releases.appId, appId), eq(releases.status, 'active')))
      .get()
  }

  /** Newest first; all apps when appId is omitted. */
  list(appId?: string): Release[] {
    return this.db
      .select()
      .from(releases)
      .where(appId ? eq(releases.appId, appId) : undefined)
      .orderBy(desc(releases.createdAt), sql`rowid DESC`)
      .all()
  }

  get(id: string): Release | undefined {
    return this.db.select().from(releases).where(eq(releases.id, id)).get()
  }

  /** Release of `appId` with `version`; the newest one if published more than once. */
  byVersion(appId: string, version: string): Release | undefined {
    return this.db
      .select()
      .from(releases)
      .where(and(eq(releases.appId, appId), eq(releases.version, version)))
      .orderBy(desc(releases.createdAt), sql`rowid DESC`)
      .get()
  }

  /** Record a new release (not yet active). */
  insert(release: NewRelease): Release {
    return this.db
      .insert(releases)
      .values({ ...release, status: 'superseded' })
      .returning()
      .get()
  }

  /** Make `releaseId` the app's single active release. */
  markActive(appId: string, releaseId: string): void {
    this.db.transaction((tx) => {
      tx.update(releases)
        .set({ status: 'superseded' })
        .where(and(eq(releases.appId, appId), eq(releases.status, 'active')))
        .run()
      tx.update(releases)
        .set({ status: 'active', activatedAt: new Date().toISOString() })
        .where(eq(releases.id, releaseId))
        .run()
    })
  }

  // ---- validation runs -------------------------------------------------------

  recordRun(run: {
    draftId: string
    appId: string
    contentHash: string
    ok: boolean
    steps: unknown
  }): ValidationRunRow {
    return this.db
      .insert(validationRuns)
      .values({ ...run, steps: JSON.stringify(run.steps) })
      .returning()
      .get()
  }

  /** Latest passing run for exactly this draft content, if any. */
  passingRun(draftId: string, contentHash: string): ValidationRunRow | undefined {
    return this.db
      .select()
      .from(validationRuns)
      .where(
        and(
          eq(validationRuns.draftId, draftId),
          eq(validationRuns.contentHash, contentHash),
          eq(validationRuns.ok, true),
        ),
      )
      .orderBy(desc(validationRuns.createdAt), sql`rowid DESC`)
      .get()
  }

  getRun(id: string): ValidationRunRow | undefined {
    return this.db.select().from(validationRuns).where(eq(validationRuns.id, id)).get()
  }

  // ---- approvals + events ----------------------------------------------------

  approve(input: {
    principal: string
    target: string
    contentHash?: string
    decision: 'approved' | 'rejected'
  }): string {
    return this.db
      .insert(approvals)
      .values({ ...input, contentHash: input.contentHash ?? null })
      .returning({ id: approvals.id })
      .get().id
  }

  event(input: {
    subjectType: 'draft' | 'release'
    subjectId: string
    appId: string
    state: string
    actor: string
    detail?: string
  }): void {
    this.db
      .insert(lifecycleEvents)
      .values({ ...input, detail: input.detail ?? null })
      .run()
  }

  events(subjectType: 'draft' | 'release', subjectId: string): LifecycleEvent[] {
    return this.db
      .select()
      .from(lifecycleEvents)
      .where(
        and(eq(lifecycleEvents.subjectType, subjectType), eq(lifecycleEvents.subjectId, subjectId)),
      )
      .orderBy(lifecycleEvents.createdAt, sql`rowid`)
      .all()
  }
}
