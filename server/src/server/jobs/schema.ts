/**
 * Platform-DB tables for durable agent jobs (mutabl spec §9, §10): job records
 * independent of SDK sessions, a globally sequenced event log, tool invocations
 * (idempotency + history) and approval requests for risky agent actions.
 * Migration: `drizzle/platform/0017_jobs.sql`.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { id } from '../db/conventions.js'

const now = () => new Date().toISOString()

export const JOB_STATES = [
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
] as const
export type JobState = (typeof JOB_STATES)[number]

/** One unit of agent work: a User Mode turn, a Developer Mode turn, an escalation. */
export const jobs = sqliteTable(
  'jobs',
  {
    ...id(),
    kind: text('kind', { enum: ['user_turn', 'dev_turn', 'escalation'] }).notNull(),
    appId: text('app_id').notNull(),
    scope: text('scope').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** Device id of the requesting principal ('local' when unknown). */
    principal: text('principal').notNull(),
    /** Correlation id: client message id, or the user row id. */
    requestId: text('request_id').notNull(),
    /** Request id of the first attempt — the idempotency scope of retries. */
    rootRequestId: text('root_request_id').notNull(),
    /** User chat row that started the job (null for escalations). */
    messageId: text('message_id'),
    retryOf: text('retry_of'),
    sdkSessionId: text('sdk_session_id'),
    state: text('state', { enum: JOB_STATES }).notNull(),
    /** Request text, bounded (what the user asked). */
    summary: text('summary').notNull(),
    /** Latest progress line ("3 tools · add_task"). */
    progress: text('progress'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    cancelRequestedAt: text('cancel_requested_at'),
    /** Assistant chat row with the result. */
    resultRef: text('result_ref'),
    createdAt: text('created_at').notNull().$defaultFn(now),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    updatedAt: text('updated_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('jobs_state_idx').on(t.state, t.updatedAt),
    index('jobs_conversation_idx').on(t.conversationId, t.createdAt),
  ],
)

/** Append-only, globally sequenced job events (spec §9.2). Payloads are bounded and secret-free. */
export const jobEvents = sqliteTable(
  'job_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    jobId: text('job_id').notNull(),
    type: text('type').notNull(),
    /** JSON object, bounded (see JobStore.event). */
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('job_events_job_idx').on(t.jobId, t.seq)],
)

/** Every agent tool call of a job: history, outcome, idempotency. */
export const toolInvocations = sqliteTable(
  'tool_invocations',
  {
    ...id(),
    jobId: text('job_id').notNull(),
    appId: text('app_id').notNull(),
    tool: text('tool').notNull(),
    risk: text('risk').notNull(),
    /** SHA-256 of the canonical arguments. */
    inputHash: text('input_hash').notNull(),
    /** Set for writes: same key across retries of one request = same effect. */
    idempotencyKey: text('idempotency_key'),
    outcome: text('outcome', {
      enum: ['started', 'ok', 'error', 'denied', 'approval_required', 'deduplicated'],
    }).notNull(),
    /** Bounded JSON of the tool result (or error). */
    result: text('result'),
    createdAt: text('created_at').notNull().$defaultFn(now),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('tool_invocations_job_idx').on(t.jobId, t.createdAt),
    index('tool_invocations_key_idx').on(t.idempotencyKey),
  ],
)

/** A risky agent action waiting for (or decided by) the user. */
export const approvalRequests = sqliteTable(
  'approval_requests',
  {
    ...id(),
    jobId: text('job_id').notNull(),
    appId: text('app_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    tool: text('tool').notNull(),
    /** JSON of the arguments the agent proposed — executed verbatim on approval. */
    args: text('args').notNull(),
    inputHash: text('input_hash').notNull(),
    summary: text('summary').notNull(),
    risk: text('risk').notNull(),
    requestedBy: text('requested_by').notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'executed', 'failed'],
    }).notNull(),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    /** Bounded JSON of the execution result or error. */
    result: text('result'),
    createdAt: text('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('approval_requests_job_idx').on(t.jobId),
    index('approval_requests_status_idx').on(t.status, t.createdAt),
  ],
)

export type Job = typeof jobs.$inferSelect
export type JobEvent = typeof jobEvents.$inferSelect
export type ToolInvocation = typeof toolInvocations.$inferSelect
export type ApprovalRequest = typeof approvalRequests.$inferSelect
