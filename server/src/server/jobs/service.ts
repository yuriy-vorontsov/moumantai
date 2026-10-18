/**
 * JobService — orchestration of durable agent jobs (mutabl spec §9):
 * lifecycle around a turn, per-job cancellation, approval decisions (the server
 * executes the approved call itself, once), retries and restart recovery.
 *
 * Authorization: a job is controlled (cancel, retry, approve, reject) by the
 * principal that started it or by an owner device.
 */

import type { ToolGate } from '../agent/agent-loop.js'
import type { ToolResult } from '../agent/types.js'
import type { ApprovalRequest, Job } from './schema.js'
import { ACTIVE_STATES, type JobStore, type NewJob } from './store.js'
import { createJobToolGate } from './tool-gate.js'

export type ActionOutcome = { ok: true; message: string } | { ok: false; error: string }

export interface JobServiceDeps {
  store: JobStore
  /** Owner check for a device id (pairing off ⇒ everyone is owner). */
  isOwner: (deviceId: string) => boolean
  /** Execute an approved call against its app (boot, run tool, refresh faces). */
  runApprovedTool: (approval: ApprovalRequest, principal: string) => Promise<ToolResult>
  /** Post a system row into the job's conversation (approval asks, outcomes). */
  postNote: (conversationId: string, text: string) => void
  /** Audit record of a decision (Phase 3 `approvals` table). */
  recordDecision?: (d: {
    principal: string
    target: string
    inputHash: string
    decision: 'approved' | 'rejected'
  }) => void
  /** Start a new run of a user turn (retry). */
  rerunUserTurn: (job: Job, text: string, principal: string) => Promise<void>
  /** Read the original request text of a job. */
  requestText: (job: Job) => string | undefined
  /** Abort a dev turn (its own AbortController lives with the draft). */
  abortDevTurn?: (job: Job) => void
  /** Something changed — push the Jobs face (caller coalesces). */
  notify: () => void
}

export interface FinishOutcome {
  ok: boolean
  resultRef?: string
  errorCode?: string
  errorMessage?: string
}

export class JobService {
  private readonly controllers = new Map<string, AbortController>()
  private readonly byConversation = new Map<string, string>()
  /** One gate per job, so occurrence counting spans delegated sub-turns. */
  private readonly gates = new Map<string, ToolGate>()

  constructor(private readonly deps: JobServiceDeps) {}

  get store(): JobStore {
    return this.deps.store
  }

  canControl(job: Job, deviceId: string | undefined): boolean {
    if (!deviceId) return false
    return deviceId === job.principal || this.deps.isOwner(deviceId)
  }

  // ---- lifecycle -------------------------------------------------------------

  create(input: NewJob): Job {
    const job = this.deps.store.create(input)
    this.deps.notify()
    return job
  }

  /**
   * QUEUED → RUNNING when the turn's slot starts. Returns the job's abort
   * signal, or null when the job was canceled while queued (do not run it).
   */
  begin(jobId: string): AbortSignal | null {
    const job = this.deps.store.get(jobId)
    if (!job || job.state !== 'QUEUED') return null
    this.deps.store.transition(jobId, 'RUNNING')
    const ac = new AbortController()
    this.controllers.set(jobId, ac)
    this.byConversation.set(job.conversationId, jobId)
    this.deps.notify()
    return ac.signal
  }

  /** The job whose turn is running on this conversation (delegation gates). */
  currentJobFor(conversationId: string): Job | undefined {
    const id = this.byConversation.get(conversationId)
    return id ? this.deps.store.get(id) : undefined
  }

  gateFor(job: Job): ToolGate {
    const cached = this.gates.get(job.id)
    if (cached) return cached
    const gate = createJobToolGate({
      store: this.deps.store,
      job,
      onApprovalRequested: (approval) => {
        this.deps.postNote(
          job.conversationId,
          `Waiting for your approval: ${approval.summary}. Approve or reject it in Agent Jobs.`,
        )
      },
      onChange: () => this.deps.notify(),
    })
    this.gates.set(job.id, gate)
    return gate
  }

  /** End of the turn: settle the job's state from the outcome and pending approvals. */
  finish(jobId: string, outcome: FinishOutcome): Job | undefined {
    this.controllers.delete(jobId)
    this.gates.delete(jobId)
    const job = this.deps.store.get(jobId)
    if (!job) return undefined
    if (this.byConversation.get(job.conversationId) === jobId)
      this.byConversation.delete(job.conversationId)
    if (job.state === 'QUEUED') {
      // Never started (queue full, app failed to boot, canceled in the queue).
      const result = this.deps.store.transition(
        jobId,
        job.cancelRequestedAt ? 'CANCELED' : 'FAILED',
        {
          errorCode: job.cancelRequestedAt ? 'canceled' : (outcome.errorCode ?? 'internal_error'),
          ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        },
      )
      this.deps.notify()
      return result
    }
    if (job.state !== 'RUNNING') return job // canceled while queued, etc.

    let result: Job
    const pending = this.deps.store.approvals({ jobId, statuses: ['pending'] })
    if (job.cancelRequestedAt) {
      this.rejectPending(job, 'system:canceled')
      result = this.deps.store.transition(jobId, 'CANCELED', {
        errorCode: 'canceled',
        ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}),
      })
    } else if (pending.length > 0) {
      result = this.deps.store.transition(jobId, 'WAITING_FOR_APPROVAL', {
        ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}),
        ...(outcome.ok ? {} : { detail: `turn ended with ${outcome.errorCode ?? 'an error'}` }),
      })
    } else if (outcome.ok) {
      result = this.deps.store.transition(jobId, 'SUCCEEDED', {
        ...(outcome.resultRef ? { resultRef: outcome.resultRef } : {}),
      })
    } else {
      result = this.deps.store.transition(jobId, 'FAILED', {
        errorCode: outcome.errorCode ?? 'internal_error',
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      })
    }
    this.deps.notify()
    return result
  }

  private rejectPending(job: Job, by: string): void {
    for (const a of this.deps.store.approvals({ jobId: job.id, statuses: ['pending'] })) {
      if (this.deps.store.decideApproval(a.id, 'rejected', by)) {
        this.deps.store.event(job.id, 'approval.decided', {
          approvalId: a.id,
          decision: 'rejected',
          by,
        })
      }
    }
  }

  // ---- cancel ----------------------------------------------------------------

  cancel(jobId: string, by: string | undefined): ActionOutcome {
    const job = this.deps.store.get(jobId)
    if (!job) return { ok: false, error: 'That job no longer exists.' }
    if (!this.canControl(job, by))
      return {
        ok: false,
        error: 'Only the person who started this job, or the owner, can cancel it.',
      }
    if (!ACTIVE_STATES.includes(job.state))
      return { ok: false, error: `The job already ${job.state.toLowerCase().replace(/_/g, ' ')}.` }

    this.deps.store.requestCancel(jobId, by!)
    if (job.state === 'QUEUED') {
      this.deps.store.transition(jobId, 'CANCELED', {
        errorCode: 'canceled',
        detail: 'canceled before it started',
      })
    } else if (job.state === 'WAITING_FOR_APPROVAL') {
      this.rejectPending(job, `system:canceled`)
      this.deps.store.transition(jobId, 'CANCELED', { errorCode: 'canceled' })
    } else {
      // RUNNING: stop this job's run only; finish() settles CANCELED.
      if (job.kind === 'dev_turn') this.deps.abortDevTurn?.(job)
      this.controllers.get(jobId)?.abort()
    }
    this.deps.notify()
    return { ok: true, message: 'Canceling. Actions that already completed are not undone.' }
  }

  // ---- approvals -------------------------------------------------------------

  async respondApproval(
    approvalId: string,
    decision: 'approve' | 'reject',
    by: string | undefined,
  ): Promise<ActionOutcome> {
    const { store } = this.deps
    const approval = store.getApproval(approvalId)
    if (!approval) return { ok: false, error: 'That approval request no longer exists.' }
    const job = store.get(approval.jobId)
    if (!job) return { ok: false, error: 'The job for this request no longer exists.' }
    if (!this.canControl(job, by)) {
      return { ok: false, error: 'Only the person who asked, or the owner, can decide.' }
    }
    const decided = store.decideApproval(
      approvalId,
      decision === 'approve' ? 'approved' : 'rejected',
      by!,
    )
    if (!decided) return { ok: false, error: `Already ${approval.status}.` }

    this.deps.recordDecision?.({
      principal: by!,
      target: `tool:${approvalId}`,
      inputHash: approval.inputHash,
      decision: decided.status === 'approved' ? 'approved' : 'rejected',
    })
    store.event(job.id, 'approval.decided', { approvalId, decision: decided.status, by })

    if (decided.status === 'rejected') {
      this.deps.postNote(job.conversationId, `Not done — you rejected: ${approval.summary}.`)
      this.settleAfterDecision(job.id, true)
      this.deps.notify()
      return { ok: true, message: `Rejected: ${approval.summary}` }
    }

    // Approved: run the stored call now (no LLM), exactly as proposed.
    const turnRunning = this.controllers.has(job.id)
    if (job.state === 'WAITING_FOR_APPROVAL')
      store.transition(job.id, 'RUNNING', { detail: 'approved' })
    this.deps.notify()
    let result: ToolResult
    try {
      result = await this.deps.runApprovedTool(decided, by!)
    } catch (err) {
      result = { result: null, error: err instanceof Error ? err.message : String(err) }
    }
    const ok = !result.error
    store.settleApproval(approvalId, ok ? 'executed' : 'failed', result.error ?? result.result)
    store.event(job.id, 'tool.finished', {
      tool: approval.tool,
      ok,
      approvalId,
      ...(result.error ? { error: result.error.slice(0, 200) } : {}),
    })
    this.deps.postNote(
      job.conversationId,
      ok ? `Done: ${approval.summary}.` : `Could not do it: ${approval.summary} — ${result.error}`,
    )
    if (!turnRunning) this.settleAfterDecision(job.id, ok)
    this.deps.notify()
    return ok
      ? { ok: true, message: `Done: ${approval.summary}` }
      : { ok: false, error: result.error! }
  }

  /** After a decision with no turn running: close the job once nothing is pending. */
  private settleAfterDecision(jobId: string, ok: boolean): void {
    const job = this.deps.store.get(jobId)
    if (!job || this.controllers.has(jobId)) return
    if (this.deps.store.approvals({ jobId, statuses: ['pending'] }).length > 0) {
      if (job.state === 'RUNNING') this.deps.store.transition(jobId, 'WAITING_FOR_APPROVAL')
      return
    }
    const decided = this.deps.store.approvals({ jobId })
    const anyDone = decided.some((a) => a.status === 'executed')
    if (job.state === 'WAITING_FOR_APPROVAL') {
      // Everything rejected → canceled; something ran → running → succeeded.
      if (!anyDone) {
        this.deps.store.transition(jobId, 'CANCELED', { errorCode: 'rejected' })
        return
      }
      this.deps.store.transition(jobId, 'RUNNING')
    }
    const now = this.deps.store.get(jobId)!
    if (now.state === 'RUNNING') {
      this.deps.store.transition(
        jobId,
        ok || anyDone ? 'SUCCEEDED' : 'FAILED',
        ok || anyDone ? {} : { errorCode: 'approved_action_failed' },
      )
    }
  }

  // ---- retry -----------------------------------------------------------------

  async retry(jobId: string, by: string | undefined): Promise<ActionOutcome> {
    const job = this.deps.store.get(jobId)
    if (!job) return { ok: false, error: 'That job no longer exists.' }
    if (!this.canControl(job, by))
      return {
        ok: false,
        error: 'Only the person who started this job, or the owner, can retry it.',
      }
    if (job.kind !== 'user_turn')
      return { ok: false, error: 'Only chat requests can be retried from here.' }
    if (!['FAILED', 'CANCELED', 'RECOVERY_REQUIRED'].includes(job.state)) {
      return {
        ok: false,
        error: `A ${job.state.toLowerCase().replace(/_/g, ' ')} job cannot be retried.`,
      }
    }
    const text = this.deps.requestText(job)
    if (!text) return { ok: false, error: 'The original request is no longer available.' }
    this.deps.store.event(job.id, 'retry.requested', { by })
    await this.deps.rerunUserTurn(job, text, by!)
    return {
      ok: true,
      message: 'Running it again. Actions that already completed will not be repeated.',
    }
  }

  // ---- restart recovery ----------------------------------------------------

  /**
   * Startup sweep (spec §9.3): an agent run cannot be resumed safely, so every
   * QUEUED/RUNNING job becomes INTERRUPTED → RECOVERY_REQUIRED with the list of
   * tool calls that completed. Approved-but-unsettled approvals are marked
   * failed ("may or may not have happened"). WAITING_FOR_APPROVAL survives.
   */
  recoverOnStartup(): { interrupted: number } {
    const { store } = this.deps
    for (const a of store.approvals({ statuses: ['approved'] })) {
      store.settleApproval(a.id, 'failed', {
        error:
          'The server stopped while running this approved action; it may or may not have completed.',
      })
    }
    const stuck = store.list({ states: ['QUEUED', 'RUNNING'], limit: 10_000 })
    for (const job of stuck) {
      const done = store
        .invocations(job.id)
        .filter((i) => i.outcome === 'ok')
        .map((i) => i.tool)
      const unknown = store
        .invocations(job.id)
        .filter((i) => i.outcome === 'started')
        .map((i) => i.tool)
      store.transition(job.id, 'INTERRUPTED', { detail: 'server restart' })
      store.event(job.id, 'recovery', { completed: done, unknown })
      const parts = ['Interrupted by a server restart.']
      if (done.length) parts.push(`Completed before that: ${done.join(', ')}.`)
      if (unknown.length) parts.push(`May or may not have completed: ${unknown.join(', ')}.`)
      parts.push(
        job.kind === 'user_turn'
          ? 'Retry runs it again without repeating completed actions.'
          : job.kind === 'dev_turn'
            ? 'Send the request again in the Dev tab; the draft keeps what was already written.'
            : 'Tap the action again to start over.',
      )
      store.transition(job.id, 'RECOVERY_REQUIRED', {
        errorCode: 'server_interrupted',
        errorMessage: parts.join(' '),
      })
    }
    return { interrupted: stuck.length }
  }
}
