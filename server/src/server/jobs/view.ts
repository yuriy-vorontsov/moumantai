/**
 * View model for the home app's Agent Jobs face (mutabl spec §13.1 "Agent
 * Jobs"; deliverable "Job Manager and execution history"): approvals waiting
 * for the user, running jobs, recent jobs and the sequenced event log.
 */

import type { ApprovalRequest, Job, JobEvent } from './schema.js'
import type { JobStore } from './store.js'

export interface JobsView {
  summary: {
    headline: string
    pending_approvals: number
    running: number
    has_approvals: boolean
    has_running: boolean
    has_recent: boolean
  }
  approvals: Array<{ id: string; title: string; detail: string }>
  running: Array<{ id: string; title: string; detail: string; can_cancel: boolean }>
  recent: Array<{ id: string; title: string; detail: string; can_retry: boolean }>
  events: Array<{ seq: number; line: string }>
}

const STATE_LABEL: Record<Job['state'], string> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_APPROVAL: 'waiting for approval',
  SUCCEEDED: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
  INTERRUPTED: 'interrupted',
  RECOVERY_REQUIRED: 'needs recovery',
}

function hhmm(ts: string | null | undefined): string {
  return ts ? `${ts.slice(11, 16)} UTC` : ''
}

function duration(job: Job): string {
  if (!job.startedAt) return ''
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now()
  const s = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function title(job: Job, appName: (id: string) => string): string {
  const kind = job.kind === 'dev_turn' ? 'Developer' : job.kind === 'escalation' ? 'Form' : 'Chat'
  return `${appName(job.appId)} · ${kind}: ${job.summary.length > 70 ? `${job.summary.slice(0, 69)}…` : job.summary}`
}

function eventLine(
  e: JobEvent,
  jobsById: Map<string, Job>,
  appName: (id: string) => string,
): string {
  let p: Record<string, unknown> = {}
  try {
    p = JSON.parse(e.payload) as Record<string, unknown>
  } catch {
    /* bounded payloads are always JSON; keep the line anyway */
  }
  const job = jobsById.get(e.jobId)
  const who = job ? appName(job.appId) : e.jobId.slice(0, 8)
  const what = (() => {
    switch (e.type) {
      case 'state':
        return `→ ${STATE_LABEL[p.state as Job['state']] ?? String(p.state)}${p.errorCode ? ` (${String(p.errorCode)})` : ''}`
      case 'tool.started':
        return `${String(p.tool)} started`
      case 'tool.finished':
        return `${String(p.tool)} ${p.ok ? (p.deduplicated ? 'already done (not repeated)' : 'ok') : 'failed'}`
      case 'tool.denied':
        return `${String(p.tool)} denied`
      case 'approval.requested':
        return `approval requested: ${String(p.summary)}`
      case 'approval.decided':
        return `approval ${String(p.decision)}`
      case 'cancel.requested':
        return 'cancel requested'
      case 'retry.requested':
        return 'retry requested'
      case 'recovery':
        return 'recovery check after restart'
      case 'progress':
        return String(p.text ?? 'progress')
      default:
        return e.type
    }
  })()
  return `#${e.seq} · ${hhmm(e.createdAt)} · ${who} · ${what}`
}

export function buildJobsView(store: JobStore, appName: (id: string) => string): JobsView {
  const pending: ApprovalRequest[] = store.approvals({ statuses: ['pending'] })
  const active = store.list({ states: ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL'], limit: 20 })
  const recent = store.list({
    states: ['SUCCEEDED', 'FAILED', 'CANCELED', 'RECOVERY_REQUIRED', 'INTERRUPTED'],
    limit: 12,
  })
  const events = store.recentEvents(25)
  const jobsById = new Map<string, Job>([...active, ...recent].map((j) => [j.id, j]))
  for (const e of events) {
    if (!jobsById.has(e.jobId)) {
      const j = store.get(e.jobId)
      if (j) jobsById.set(j.id, j)
    }
  }

  const running = active
  const headline =
    pending.length > 0
      ? `${pending.length} action${pending.length === 1 ? '' : 's'} waiting for your approval.`
      : active.length > 0
        ? `${active.length} job${active.length === 1 ? '' : 's'} in progress.`
        : 'No agent jobs running.'

  return {
    summary: {
      headline,
      pending_approvals: pending.length,
      running: active.length,
      has_approvals: pending.length > 0,
      has_running: running.length > 0,
      has_recent: recent.length > 0,
    },
    approvals: pending.map((a) => ({
      id: a.id,
      title: a.summary,
      detail: `${appName(a.appId)} · ${a.risk} · asked ${hhmm(a.createdAt)}`,
    })),
    running: running.map((j) => ({
      id: j.id,
      title: title(j, appName),
      // Pushed on events, not on a timer: show when it started, not a stale duration.
      detail: [STATE_LABEL[j.state], j.progress, j.startedAt ? `since ${hhmm(j.startedAt)}` : '']
        .filter(Boolean)
        .join(' · '),
      can_cancel: true,
    })),
    recent: recent.map((j) => ({
      id: j.id,
      title: title(j, appName),
      detail: [
        STATE_LABEL[j.state],
        duration(j),
        j.errorMessage ?? j.errorCode ?? '',
        hhmm(j.finishedAt ?? j.updatedAt),
      ]
        .filter(Boolean)
        .join(' · '),
      can_retry:
        j.kind === 'user_turn' && ['FAILED', 'CANCELED', 'RECOVERY_REQUIRED'].includes(j.state),
    })),
    events: events.map((e) => ({ seq: e.seq, line: eventLine(e, jobsById, appName) })),
  }
}
