/**
 * JobStore — durable job records, the sequenced event log, tool invocations and
 * approval requests (mutabl spec §9, §10). Pure persistence + the job state
 * machine; orchestration (running turns, executing approvals) lives in
 * `service.ts`.
 */

import crypto from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  approvalRequests,
  jobEvents,
  jobs,
  toolInvocations,
  type ApprovalRequest,
  type Job,
  type JobEvent,
  type JobState,
  type ToolInvocation,
} from './schema.js'

/** Spec §9.1. Terminal states have no outgoing edges; a retry is a new job. */
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  QUEUED: ['RUNNING', 'CANCELED', 'FAILED', 'INTERRUPTED'],
  RUNNING: ['WAITING_FOR_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELED', 'INTERRUPTED'],
  WAITING_FOR_APPROVAL: ['RUNNING', 'CANCELED', 'RECOVERY_REQUIRED'],
  INTERRUPTED: ['RECOVERY_REQUIRED', 'QUEUED'],
  RECOVERY_REQUIRED: [],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
}

export const ACTIVE_STATES: readonly JobState[] = ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL']
export const TERMINAL_STATES: readonly JobState[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'RECOVERY_REQUIRED',
]

export class IllegalTransitionError extends Error {
  constructor(from: JobState, to: JobState, jobId: string) {
    super(`job ${jobId}: illegal transition ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/** Max serialized size of one event payload / stored result (spec §9.2: bounded). */
export const PAYLOAD_LIMIT = 2048

/** JSON, cut to `limit` characters (a truncated marker replaces the overflow). */
export function boundedJson(value: unknown, limit = PAYLOAD_LIMIT): string {
  const json = JSON.stringify(value ?? null)
  if (json.length <= limit) return json
  return JSON.stringify({ truncated: true, preview: json.slice(0, limit - 64) })
}

/** Canonical JSON (sorted keys) so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export interface NewJob {
  kind: Job['kind']
  appId: string
  scope: string
  conversationId: string
  principal: string
  requestId: string
  messageId?: string | null
  summary: string
  /** The job this one retries; its root request id is inherited. */
  retryOf?: Job | null
}

export class JobStore {
  constructor(private readonly db: BetterSQLite3Database<Record<string, unknown>>) {}

  // ---- jobs ----------------------------------------------------------------

  create(input: NewJob): Job {
    const ts = new Date().toISOString()
    const job = this.db
      .insert(jobs)
      .values({
        kind: input.kind,
        appId: input.appId,
        scope: input.scope,
        conversationId: input.conversationId,
        principal: input.principal,
        requestId: input.requestId,
        rootRequestId: input.retryOf?.rootRequestId ?? input.requestId,
        messageId: input.messageId ?? null,
        retryOf: input.retryOf?.id ?? null,
        retryCount: input.retryOf ? input.retryOf.retryCount + 1 : 0,
        state: 'QUEUED',
        summary: input.summary.slice(0, 280),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get()
    this.event(job.id, 'state', {
      state: 'QUEUED',
      ...(input.retryOf ? { retryOf: input.retryOf.id } : {}),
    })
    return job
  }

  get(jobId: string): Job | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, jobId)).get()
  }

  byMessageId(messageId: string): Job | undefined {
    return this.db.select().from(jobs).where(eq(jobs.messageId, messageId)).get()
  }

  /** Newest first. */
  list(opts: { states?: readonly JobState[]; limit?: number } = {}): Job[] {
    return this.db
      .select()
      .from(jobs)
      .where(opts.states ? inArray(jobs.state, [...opts.states]) : undefined)
      .orderBy(desc(jobs.createdAt), sql`rowid DESC`)
      .limit(opts.limit ?? 50)
      .all()
  }

  /**
   * Move a job to `to`, enforcing the state machine. Records a `state` event.
   * Stamps startedAt on the first RUNNING and finishedAt on terminal states.
   */
  transition(
    jobId: string,
    to: JobState,
    patch: { errorCode?: string; errorMessage?: string; resultRef?: string; detail?: string } = {},
  ): Job {
    const job = this.get(jobId)
    if (!job) throw new Error(`job ${jobId} not found`)
    if (job.state === to) return job
    if (!TRANSITIONS[job.state].includes(to)) throw new IllegalTransitionError(job.state, to, jobId)
    const ts = new Date().toISOString()
    const updated = this.db
      .update(jobs)
      .set({
        state: to,
        updatedAt: ts,
        ...(to === 'RUNNING' && !job.startedAt ? { startedAt: ts } : {}),
        ...(TERMINAL_STATES.includes(to) ? { finishedAt: ts } : {}),
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        ...(patch.errorMessage !== undefined
          ? { errorMessage: patch.errorMessage.slice(0, 500) }
          : {}),
        ...(patch.resultRef !== undefined ? { resultRef: patch.resultRef } : {}),
      })
      .where(eq(jobs.id, jobId))
      .returning()
      .get()
    this.event(jobId, 'state', {
      state: to,
      from: job.state,
      ...(patch.errorCode ? { errorCode: patch.errorCode } : {}),
      ...(patch.detail ? { detail: patch.detail.slice(0, 300) } : {}),
    })
    return updated
  }

  setProgress(jobId: string, progress: string): void {
    this.db
      .update(jobs)
      .set({ progress: progress.slice(0, 200), updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, jobId))
      .run()
  }

  setSdkSession(jobId: string, sdkSessionId: string): void {
    this.db.update(jobs).set({ sdkSessionId }).where(eq(jobs.id, jobId)).run()
  }

  /** Record a cancel request (idempotent). Returns the job. */
  requestCancel(jobId: string, by: string): Job {
    const job = this.get(jobId)
    if (!job) throw new Error(`job ${jobId} not found`)
    if (job.cancelRequestedAt) return job
    const ts = new Date().toISOString()
    const updated = this.db
      .update(jobs)
      .set({ cancelRequestedAt: ts, updatedAt: ts })
      .where(eq(jobs.id, jobId))
      .returning()
      .get()
    this.event(jobId, 'cancel.requested', { by })
    return updated
  }

  // ---- events --------------------------------------------------------------

  /** Append an event; returns its global sequence number. */
  event(jobId: string, type: string, payload: Record<string, unknown> = {}): number {
    const row = this.db
      .insert(jobEvents)
      .values({ jobId, type, payload: boundedJson(payload) })
      .returning({ seq: jobEvents.seq })
      .get()
    return row.seq
  }

  /** Events with seq > `afterSeq`, oldest first (the replay primitive, spec §9.2). */
  eventsAfter(afterSeq: number, opts: { jobId?: string; limit?: number } = {}): JobEvent[] {
    return this.db
      .select()
      .from(jobEvents)
      .where(
        and(gt(jobEvents.seq, afterSeq), opts.jobId ? eq(jobEvents.jobId, opts.jobId) : undefined),
      )
      .orderBy(asc(jobEvents.seq))
      .limit(opts.limit ?? 500)
      .all()
  }

  /** The newest `limit` events, newest first. */
  recentEvents(limit = 20): JobEvent[] {
    return this.db.select().from(jobEvents).orderBy(desc(jobEvents.seq)).limit(limit).all()
  }

  lastSeq(): number {
    const row = this.db
      .select({ seq: jobEvents.seq })
      .from(jobEvents)
      .orderBy(desc(jobEvents.seq))
      .limit(1)
      .get()
    return row?.seq ?? 0
  }

  // ---- tool invocations ----------------------------------------------------

  startInvocation(input: {
    jobId: string
    appId: string
    tool: string
    risk: string
    inputHash: string
    idempotencyKey?: string | null
    outcome?: ToolInvocation['outcome']
    result?: unknown
  }): ToolInvocation {
    const outcome = input.outcome ?? 'started'
    return this.db
      .insert(toolInvocations)
      .values({
        jobId: input.jobId,
        appId: input.appId,
        tool: input.tool,
        risk: input.risk,
        inputHash: input.inputHash,
        idempotencyKey: input.idempotencyKey ?? null,
        outcome,
        ...(input.result !== undefined ? { result: boundedJson(input.result) } : {}),
        ...(outcome !== 'started' ? { finishedAt: new Date().toISOString() } : {}),
      })
      .returning()
      .get()
  }

  finishInvocation(id: string, outcome: ToolInvocation['outcome'], result: unknown): void {
    this.db
      .update(toolInvocations)
      .set({ outcome, result: boundedJson(result), finishedAt: new Date().toISOString() })
      .where(eq(toolInvocations.id, id))
      .run()
  }

  /** A successful invocation with this key from another job (a previous attempt). */
  completedByKey(idempotencyKey: string, excludeJobId: string): ToolInvocation | undefined {
    return this.db
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.idempotencyKey, idempotencyKey),
          eq(toolInvocations.outcome, 'ok'),
          ne(toolInvocations.jobId, excludeJobId),
        ),
      )
      .orderBy(asc(toolInvocations.createdAt))
      .get()
  }

  invocations(jobId: string): ToolInvocation[] {
    return this.db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.jobId, jobId))
      .orderBy(asc(toolInvocations.createdAt), sql`rowid`)
      .all()
  }

  // ---- approval requests ---------------------------------------------------

  createApproval(input: {
    jobId: string
    appId: string
    conversationId: string
    tool: string
    args: Record<string, unknown>
    summary: string
    risk: string
    requestedBy: string
  }): ApprovalRequest {
    return this.db
      .insert(approvalRequests)
      .values({
        jobId: input.jobId,
        appId: input.appId,
        conversationId: input.conversationId,
        tool: input.tool,
        args: JSON.stringify(input.args),
        inputHash: sha256(canonicalJson(input.args)),
        summary: input.summary.slice(0, 280),
        risk: input.risk,
        requestedBy: input.requestedBy,
        status: 'pending',
      })
      .returning()
      .get()
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
  }

  approvals(
    opts: { jobId?: string; statuses?: ApprovalRequest['status'][] } = {},
  ): ApprovalRequest[] {
    return this.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          opts.jobId ? eq(approvalRequests.jobId, opts.jobId) : undefined,
          opts.statuses ? inArray(approvalRequests.status, opts.statuses) : undefined,
        ),
      )
      .orderBy(asc(approvalRequests.createdAt), sql`rowid`)
      .all()
  }

  /**
   * pending → approved | rejected, atomically. Returns the decided row, or
   * undefined when it was no longer pending (double tap, race, restart).
   */
  decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    by: string,
  ): ApprovalRequest | undefined {
    return this.db
      .update(approvalRequests)
      .set({ status: decision, decidedBy: by, decidedAt: new Date().toISOString() })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending')))
      .returning()
      .get()
  }

  /** approved → executed | failed (the effect of an approved request). */
  settleApproval(id: string, status: 'executed' | 'failed', result: unknown): void {
    this.db
      .update(approvalRequests)
      .set({ status, result: boundedJson(result) })
      .where(eq(approvalRequests.id, id))
      .run()
  }
}
