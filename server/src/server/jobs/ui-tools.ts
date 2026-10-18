/**
 * UI-only controls for agent jobs (mutabl spec §9.3, §13.1): approve/reject an
 * agent action, cancel a job, retry a failed or interrupted one. Synthesized on
 * EVERY app (the Agent Jobs sheet can be opened over any app and taps route to
 * the active app's registry). Never offered to or callable by an agent.
 */

import type { ToolDefinition } from '../agent/types.js'
import type { ActionOutcome, JobService } from './service.js'

export const JOB_UI_TOOLS = ['respond_approval', 'cancel_job', 'retry_job'] as const

function toResult(o: ActionOutcome) {
  return o.ok ? { result: { ok: true, message: o.message } } : { result: null, error: o.error }
}

export function jobUiTools(service: JobService): ToolDefinition[] {
  return [
    {
      name: 'respond_approval',
      description: 'Approve or reject an action an agent asked to perform.',
      parameters: {
        approval_id: { type: 'string', required: true, description: 'Approval request id' },
        decision: { type: 'string', required: true, description: "'approve' or 'reject'" },
      },
      uiOnly: true,
      risk: 'write',
      execute: async ({ params, originDeviceId }) => {
        const decision =
          params.decision === 'approve' ? 'approve' : params.decision === 'reject' ? 'reject' : null
        if (!decision) return { result: null, error: "decision must be 'approve' or 'reject'" }
        return toResult(
          await service.respondApproval(String(params.approval_id), decision, originDeviceId),
        )
      },
    },
    {
      name: 'cancel_job',
      description: 'Cancel a queued, running or waiting agent job.',
      parameters: { job_id: { type: 'string', required: true, description: 'Job id' } },
      uiOnly: true,
      risk: 'write',
      execute: async ({ params, originDeviceId }) =>
        toResult(service.cancel(String(params.job_id), originDeviceId)),
    },
    {
      name: 'retry_job',
      description: 'Run a failed, canceled or interrupted chat request again.',
      parameters: { job_id: { type: 'string', required: true, description: 'Job id' } },
      uiOnly: true,
      risk: 'write',
      execute: async ({ params, originDeviceId }) =>
        toResult(await service.retry(String(params.job_id), originDeviceId)),
    },
  ]
}
