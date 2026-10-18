/**
 * The job-level ToolGate (mutabl spec §6.3, §9.3) plugged into AgentLoop for
 * every agent turn:
 *
 *  - destructive / external tool → NOT executed; an approval request is filed
 *    and the model is told the action is waiting for the user;
 *  - write → idempotency key `root request + tool + canonical args + n-th
 *    occurrence`; a retry of the same request gets the recorded result of the
 *    earlier attempt instead of a second effect (no duplicate task);
 *  - every call → tool.started / tool.finished events and an invocation row.
 */

import type { ToolGate, ToolGateCall } from '../agent/agent-loop.js'
import { needsApproval, toolRisk, type ToolResult } from '../agent/types.js'
import type { ApprovalRequest, Job } from './schema.js'
import { canonicalJson, sha256, type JobStore } from './store.js'

/** What the model receives instead of running an approval-gated tool. */
export function approvalRequiredResult(approval: ApprovalRequest): ToolResult {
  return {
    result: {
      status: 'approval_required',
      approval_id: approval.id,
      action: approval.summary,
      message:
        'NOT done yet. The user must approve this action in Agent Jobs. Tell them it is waiting for their approval; do not call the tool again and do not say it is done.',
    },
  }
}

export interface JobToolGateDeps {
  store: JobStore
  job: Job
  /** Called after an approval request is stored (post a chat row, push the Jobs face). */
  onApprovalRequested?: (approval: ApprovalRequest) => void
  /** Called after every event-worthy step (push the Jobs face). */
  onChange?: () => void
}

export function createJobToolGate(deps: JobToolGateDeps): ToolGate {
  const { store, job } = deps
  const occurrences = new Map<string, number>()
  const pending = new Map<ToolGateCall, { invocationId: string; started: number }>()
  let calls = 0

  const progress = (name: string) => {
    calls++
    store.setProgress(job.id, `${calls} tool call${calls === 1 ? '' : 's'} · ${name}`)
  }

  return {
    async before(call) {
      const risk = toolRisk(call.tool)
      const inputHash = sha256(canonicalJson(call.args))
      progress(call.name)
      store.event(job.id, 'tool.started', { tool: call.name, app: call.appId, risk })

      if (needsApproval(call.tool)) {
        let summary = `${call.name} ${canonicalJson(call.args)}`
        try {
          summary =
            (await call.tool.approvalSummary?.({ params: call.args, db: call.db })) ?? summary
        } catch {
          /* fall back to the raw call */
        }
        const approval = store.createApproval({
          jobId: job.id,
          appId: call.appId,
          conversationId: job.conversationId,
          tool: call.name,
          args: call.args,
          summary,
          risk,
          requestedBy: job.principal,
        })
        store.startInvocation({
          jobId: job.id,
          appId: call.appId,
          tool: call.name,
          risk,
          inputHash,
          outcome: 'approval_required',
          result: { approvalId: approval.id },
        })
        store.event(job.id, 'approval.requested', {
          approvalId: approval.id,
          tool: call.name,
          summary: approval.summary,
          risk,
        })
        deps.onApprovalRequested?.(approval)
        deps.onChange?.()
        return approvalRequiredResult(approval)
      }

      let idempotencyKey: string | null = null
      if (risk !== 'read') {
        const base = `${call.appId}:${call.name}:${inputHash}`
        const n = (occurrences.get(base) ?? 0) + 1
        occurrences.set(base, n)
        idempotencyKey = sha256(`${job.rootRequestId}|${base}|${n}`)
        const earlier = store.completedByKey(idempotencyKey, job.id)
        if (earlier) {
          const recorded = earlier.result ? (JSON.parse(earlier.result) as unknown) : null
          store.startInvocation({
            jobId: job.id,
            appId: call.appId,
            tool: call.name,
            risk,
            inputHash,
            idempotencyKey,
            outcome: 'deduplicated',
            result: { sameAs: earlier.id },
          })
          store.event(job.id, 'tool.finished', {
            tool: call.name,
            ok: true,
            deduplicated: true,
          })
          deps.onChange?.()
          return {
            result: {
              ...(recorded && typeof recorded === 'object'
                ? (recorded as object)
                : { value: recorded }),
              already_done: true,
              note: 'This exact action already completed in an earlier attempt of this request; it was not repeated.',
            },
          }
        }
      }

      const inv = store.startInvocation({
        jobId: job.id,
        appId: call.appId,
        tool: call.name,
        risk,
        inputHash,
        idempotencyKey,
      })
      pending.set(call, { invocationId: inv.id, started: Date.now() })
      return undefined
    },

    after(call, result) {
      const entry = pending.get(call)
      pending.delete(call)
      const ok = !result.error
      if (entry) {
        store.finishInvocation(
          entry.invocationId,
          ok ? 'ok' : 'error',
          result.error ?? result.result,
        )
      }
      store.event(job.id, 'tool.finished', {
        tool: call.name,
        ok,
        ...(entry ? { ms: Date.now() - entry.started } : {}),
        ...(result.error ? { error: result.error.slice(0, 200) } : {}),
      })
      deps.onChange?.()
    },

    denied(name) {
      store.startInvocation({
        jobId: job.id,
        appId: job.appId,
        tool: name,
        risk: 'unknown',
        inputHash: '',
        outcome: 'denied',
      })
      store.event(job.id, 'tool.denied', { tool: name })
      deps.onChange?.()
    },
  }
}
