/**
 * Agent Jobs (mutabl spec §13.1, §9): actions waiting for the user's approval,
 * running jobs with Cancel, recent jobs with Retry, and the sequenced event
 * log. Data comes from the job store via `setJobsView`, wired by the server.
 * Buttons call the UI-only job tools (respond_approval, cancel_job, retry_job),
 * which the server synthesizes on every app and authorizes per job.
 */

import { defineFace } from '../../../agent/define-face.js'
import {
  scaffold,
  topBar,
  column,
  text,
  list,
  card,
  row,
  button,
  pathRef,
  invokeTool,
  sectionHeader,
} from 'moumantai/ui'
import type { JobsView } from '../../../jobs/view.js'

let provideView: () => JobsView = () => ({
  summary: {
    headline: 'No agent jobs running.',
    pending_approvals: 0,
    running: 0,
    has_approvals: false,
    has_running: false,
    has_recent: false,
  },
  approvals: [],
  running: [],
  recent: [],
  events: [],
})

/** Called by the server once its job store exists. */
export function setJobsView(provider: () => JobsView): void {
  provideView = provider
}

export default defineFace({
  id: 'jobs',
  label: 'Agent Jobs',
  position: 2,
  viewToolDescription: 'Show agent jobs: approvals waiting for the user, running and recent jobs.',
  components: [
    scaffold('root', { body: 'content', top_bar: 'top' }),
    topBar('top', 'Agent Jobs'),
    column(
      'content',
      [
        'headline',
        'approvals_header',
        'approval_list',
        'running_header',
        'running_list',
        'recent_header',
        'recent_list',
        'events_header',
        'event_list',
      ],
      { spacing: 12, padding: 16 },
    ),
    text('headline', pathRef('/summary/headline'), { typography: 'bodyMedium' }),

    ...sectionHeader('approvals_header', 'Needs your approval', {
      visible: pathRef('/summary/has_approvals'),
    }),
    list('approval_list', '/approvals', 'approval_card'),
    card('approval_card', ['approval_body'], { tone: 'warning' }),
    column('approval_body', ['approval_text', 'approval_actions'], { spacing: 8 }),
    column('approval_text', ['approval_title', 'approval_detail'], { spacing: 2 }),
    text('approval_title', pathRef('$.title'), { typography: 'titleSmall' }),
    text('approval_detail', pathRef('$.detail'), { typography: 'bodySmall' }),
    row('approval_actions', ['approve_button', 'reject_button'], { spacing: 8 }),
    button('approve_button', 'Approve', {
      emphasis: 'primary',
      action: invokeTool('respond_approval', { approval_id: pathRef('$.id'), decision: 'approve' }),
    }),
    button('reject_button', 'Reject', {
      emphasis: 'standard',
      tone: 'error',
      action: invokeTool('respond_approval', { approval_id: pathRef('$.id'), decision: 'reject' }),
    }),

    ...sectionHeader('running_header', 'In progress', { visible: pathRef('/summary/has_running') }),
    list('running_list', '/running', 'running_card'),
    card('running_card', ['running_row']),
    row('running_row', ['running_text', 'cancel_button'], {
      spacing: 12,
      vertical_alignment: 'center',
    }),
    column('running_text', ['running_title', 'running_detail'], { spacing: 2, weight: 1 }),
    text('running_title', pathRef('$.title'), { typography: 'titleSmall' }),
    text('running_detail', pathRef('$.detail'), { typography: 'bodySmall' }),
    button('cancel_button', 'Cancel', {
      emphasis: 'quiet',
      visible: pathRef('$.can_cancel'),
      action: invokeTool('cancel_job', { job_id: pathRef('$.id') }),
    }),

    ...sectionHeader('recent_header', 'Recent', { visible: pathRef('/summary/has_recent') }),
    list('recent_list', '/recent', 'recent_card'),
    card('recent_card', ['recent_row']),
    row('recent_row', ['recent_text', 'retry_button'], {
      spacing: 12,
      vertical_alignment: 'center',
    }),
    column('recent_text', ['recent_title', 'recent_detail'], { spacing: 2, weight: 1 }),
    text('recent_title', pathRef('$.title'), { typography: 'titleSmall' }),
    text('recent_detail', pathRef('$.detail'), { typography: 'bodySmall' }),
    button('retry_button', 'Retry', {
      emphasis: 'quiet',
      visible: pathRef('$.can_retry'),
      action: invokeTool('retry_job', { job_id: pathRef('$.id') }),
    }),

    ...sectionHeader('events_header', 'Event log'),
    list('event_list', '/events', 'event_line'),
    text('event_line', pathRef('$.line'), { typography: 'bodySmall' }),
  ],
  resolve: () => ({ ...provideView() }),
})
