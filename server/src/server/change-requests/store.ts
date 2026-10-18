/**
 * ChangeRequestStore — persistence for User Mode → Developer Mode handoff.
 *
 * Lifecycle: open → in_progress (linked to a draft by a dev turn) → done
 * (draft promoted) | open again (draft discarded) | rejected (owner, CLI).
 */

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { changeRequests, type ChangeRequest } from './schema.js'

const ACTIVE = ['open', 'in_progress'] as const

/** Collapse whitespace so retried/rephrased-identical requests dedupe. */
function normalize(request: string): string {
  return request.trim().replace(/\s+/g, ' ')
}

export class ChangeRequestStore {
  // Any drizzle handle on platform.db (the typed PlatformDb included).
  constructor(private readonly db: BetterSQLite3Database<Record<string, unknown>>) {}

  /**
   * Record a request. Idempotent: an active request for the same app with the
   * same text (case-insensitive) is returned instead of a duplicate.
   */
  create(input: {
    appId: string
    request: string
    originDeviceId?: string
    conversationId?: string
  }): { changeRequest: ChangeRequest; existing: boolean } {
    const request = normalize(input.request)
    const duplicate = this.db
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.appId, input.appId),
          inArray(changeRequests.status, [...ACTIVE]),
          sql`lower(${changeRequests.request}) = lower(${request})`,
        ),
      )
      .get()
    if (duplicate) return { changeRequest: duplicate, existing: true }

    const max = this.db
      .select({ n: sql<number>`coalesce(max(${changeRequests.number}), 0)` })
      .from(changeRequests)
      .get()
    const row = this.db
      .insert(changeRequests)
      .values({
        number: (max?.n ?? 0) + 1,
        appId: input.appId,
        request,
        originDeviceId: input.originDeviceId ?? null,
        conversationId: input.conversationId ?? null,
      })
      .returning()
      .get()
    return { changeRequest: row, existing: false }
  }

  getByNumber(number: number): ChangeRequest | undefined {
    return this.db.select().from(changeRequests).where(eq(changeRequests.number, number)).get()
  }

  /** Open + in-progress requests, newest first; optionally for one app. */
  listActive(appId?: string): ChangeRequest[] {
    return this.db
      .select()
      .from(changeRequests)
      .where(
        and(
          inArray(changeRequests.status, [...ACTIVE]),
          appId ? eq(changeRequests.appId, appId) : undefined,
        ),
      )
      .orderBy(desc(changeRequests.number))
      .all()
  }

  listAll(): ChangeRequest[] {
    return this.db.select().from(changeRequests).orderBy(desc(changeRequests.number)).all()
  }

  /**
   * Attach the app's open requests (plus any already on this draft) to the
   * draft working on that app; returns everything the draft now carries.
   */
  linkToDraft(appId: string, draftId: string): ChangeRequest[] {
    this.db
      .update(changeRequests)
      .set({ status: 'in_progress', draftId })
      .where(
        and(
          eq(changeRequests.appId, appId),
          eq(changeRequests.status, 'open'),
          or(isNull(changeRequests.draftId), eq(changeRequests.draftId, draftId)),
        ),
      )
      .run()
    return this.forDraft(draftId)
  }

  forDraft(draftId: string): ChangeRequest[] {
    return this.db
      .select()
      .from(changeRequests)
      .where(and(eq(changeRequests.draftId, draftId), eq(changeRequests.status, 'in_progress')))
      .orderBy(changeRequests.number)
      .all()
  }

  /** Draft promoted: its requests are done. */
  completeDraft(draftId: string): void {
    this.db
      .update(changeRequests)
      .set({ status: 'done' })
      .where(and(eq(changeRequests.draftId, draftId), eq(changeRequests.status, 'in_progress')))
      .run()
  }

  /** Draft discarded: its requests go back to open, unlinked. */
  releaseDraft(draftId: string): void {
    this.db
      .update(changeRequests)
      .set({ status: 'open', draftId: null })
      .where(and(eq(changeRequests.draftId, draftId), eq(changeRequests.status, 'in_progress')))
      .run()
  }

  /** Owner closes a request without building it. False if unknown or already closed. */
  reject(number: number): boolean {
    const r = this.db
      .update(changeRequests)
      .set({ status: 'rejected' })
      .where(and(eq(changeRequests.number, number), inArray(changeRequests.status, [...ACTIVE])))
      .run()
    return (r.changes ?? 0) > 0
  }
}
