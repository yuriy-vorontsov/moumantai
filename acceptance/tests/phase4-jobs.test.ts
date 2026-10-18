/**
 * Phase 4 acceptance (spec §15, §9, §6.3): AT-13 … AT-16 against the real
 * server with the Task Manager (`apps/todo`), pairing on, an owner and two
 * user devices, and a scripted agent.
 *
 *   AT-13  Approval   → an agent's destructive action waits for explicit
 *                       approval; reject runs nothing, approve runs it once.
 *   AT-14  Long job   → the UI stays usable while a job runs; progress,
 *                       completion, cancellation and errors are visible.
 *   AT-15  Reconnect  → a client that was away receives what it missed, once.
 *   AT-16  Restart    → an interrupted job gets an accurate recoverable status;
 *                       a retry repeats no side effect; approvals survive.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { ChatRole, type ServerMessage } from '@moumantai/protocol/generated/moumantai/v1'
import { tasks } from '../../apps/todo/schema.js'
import { JobStore } from '../../server/src/server/jobs/store.js'
import type { JobsView } from '../../server/src/server/jobs/view.js'
import {
  SpyAgentAdapter,
  TestClient,
  chat,
  connectTo,
  hold,
  invokeTool,
  startServer,
  waitFor,
  type RunningServer,
} from '../helpers.js'

const OWNER = 'acceptance-owner-device-000000000041'
const USER = 'acceptance-user-device-0000000000042'
const OTHER = 'acceptance-user-device-0000000000043'

function pair(server: RunningServer): void {
  const store = server.components.store
  store.setDevicePaired(OWNER, true)
  store.setDeviceRole(OWNER, 'owner')
  store.setDevicePaired(USER, true)
  store.setDevicePaired(OTHER, true)
}

const opts = (agent: SpyAgentAdapter) => ({
  adapterOverride: agent,
  pairingRequired: true,
  devModeEnabled: true,
})

const jobsOf = (server: RunningServer) => new JobStore(server.components.platformDb)
const todoDb = (server: RunningServer) => server.components.appEngine.getApp('todo')!.db
const titles = (server: RunningServer) =>
  todoDb(server)
    .select()
    .from(tasks)
    .all()
    .map((t) => t.title)
    .sort()

/** The newest Agent Jobs face a client received (pushed to every phone session). */
function jobsView(c: TestClient, from = 0): JobsView | undefined {
  for (let i = c.received.length - 1; i >= from; i--) {
    const m = c.received[i]!
    if (
      m.payload.case === 'faceUpdate' &&
      m.payload.value.appId === 'home' &&
      m.payload.value.faceId === 'jobs'
    ) {
      return m.payload.value.data as unknown as JobsView
    }
  }
  return undefined
}

function errorsSince(c: TestClient, from: number): string[] {
  return c.received
    .slice(from)
    .filter((m): m is ServerMessage & { payload: { case: 'error' } } => m.payload.case === 'error')
    .map((m) => m.payload.value.message)
}

function chatTexts(c: TestClient, role: ChatRole, from = 0): string[] {
  return c.received
    .slice(from)
    .filter((m) => m.payload.case === 'chat' && m.payload.value.role === role)
    .map((m) => (m.payload.case === 'chat' ? m.payload.value.text : ''))
}

async function addTaskViaUi(server: RunningServer, c: TestClient, title: string): Promise<string> {
  invokeTool(c, 'add_task', { title })
  const row = await waitFor(c.received, () =>
    todoDb(server).select().from(tasks).where(eq(tasks.title, title)).get(),
  )
  return row.id
}

// ---------------------------------------------------------------------------

describe('Phase 4 on one server', () => {
  let server: RunningServer
  const agent = new SpyAgentAdapter()
  let user: TestClient
  let other: TestClient
  let owner: TestClient

  beforeAll(async () => {
    server = await startServer(['todo'], opts(agent))
    pair(server)
    user = await connectTo(server.port, 'todo', USER)
    other = await connectTo(server.port, 'todo', OTHER)
    owner = await connectTo(server.port, 'todo', OWNER)
  }, 30_000)

  afterAll(async () => {
    user?.close()
    other?.close()
    owner?.close()
    await server.stop()
  })

  describe('AT-13: approval', () => {
    let rentId: string

    it("an agent's delete waits for approval; nothing is deleted yet", async () => {
      rentId = await addTaskViaUi(server, user, 'Pay rent')
      const from = user.received.length
      agent.queue([
        { type: 'toolCall', callId: 'd1', name: 'delete_task', args: { id: rentId } },
        { type: 'text', text: 'I asked for your approval to delete it.' },
        { type: 'done' },
      ])
      chat(user, 'todo', 'delete the rent task')

      const view = await waitFor(user.received, () => {
        const v = jobsView(user, from)
        return v?.approvals.length ? v : undefined
      })
      expect(view.approvals[0]).toMatchObject({ title: 'Delete task “Pay rent”' })
      expect(view.summary.pending_approvals).toBe(1)
      // The model saw "approval required", not a deletion.
      expect(agent.toolResults.at(-1)?.result).toMatchObject({ status: 'approval_required' })
      expect(titles(server)).toContain('Pay rent')
      // The deterministic note in the chat, and the job is waiting.
      await waitFor(user.received, () =>
        chatTexts(user, ChatRole.SYSTEM, from).some((t) =>
          t.includes('Waiting for your approval: Delete task “Pay rent”'),
        ),
      )
      await waitFor(user.received, () => jobsOf(server).list()[0]?.state === 'WAITING_FOR_APPROVAL')
      // The tool description told the model up front.
      const offered = agent.turns.at(-1)!.tools.find((t) => t.name === 'delete_task')!
      expect(offered.description).toContain("Requires the user's approval")
    })

    it('another user cannot decide; the requester rejects → nothing runs, job canceled', async () => {
      const approvalId = jobsView(user)!.approvals[0]!.id
      const fromOther = other.received.length
      invokeTool(
        other,
        'respond_approval',
        { approval_id: approvalId, decision: 'approve' },
        'jobs',
      )
      await waitFor(other.received, () => errorsSince(other, fromOther).length > 0)
      expect(errorsSince(other, fromOther)[0]).toContain(
        'Only the person who asked, or the owner, can decide.',
      )
      expect(titles(server)).toContain('Pay rent')

      const from = user.received.length
      invokeTool(user, 'respond_approval', { approval_id: approvalId, decision: 'reject' }, 'jobs')
      await waitFor(user.received, () =>
        chatTexts(user, ChatRole.SYSTEM, from).some((t) => t.startsWith('Not done — you rejected')),
      )
      expect(titles(server)).toContain('Pay rent')
      expect(jobsOf(server).list()[0]).toMatchObject({ state: 'CANCELED', errorCode: 'rejected' })
    })

    it('approved → deleted exactly once; the job succeeds; a second tap is refused', async () => {
      agent.queue([
        { type: 'toolCall', callId: 'd2', name: 'delete_task', args: { id: rentId } },
        { type: 'text', text: 'Waiting for your approval.' },
        { type: 'done' },
      ])
      const from = user.received.length
      chat(user, 'todo', 'delete the rent task, really')
      const approvalId = (await waitFor(user.received, () => jobsView(user, from)?.approvals[0])).id
      await waitFor(user.received, () => jobsOf(server).list()[0]?.state === 'WAITING_FOR_APPROVAL')

      // The owner may decide for any job.
      invokeTool(
        owner,
        'respond_approval',
        { approval_id: approvalId, decision: 'approve' },
        'jobs',
      )
      await waitFor(user.received, () => !titles(server).includes('Pay rent'))
      await waitFor(user.received, () => jobsOf(server).list()[0]?.state === 'SUCCEEDED')
      await waitFor(user.received, () =>
        chatTexts(user, ChatRole.SYSTEM, from).some((t) => t === 'Done: Delete task “Pay rent”.'),
      )
      const fromAgain = owner.received.length
      invokeTool(
        owner,
        'respond_approval',
        { approval_id: approvalId, decision: 'approve' },
        'jobs',
      )
      await waitFor(owner.received, () => errorsSince(owner, fromAgain).length > 0)
      expect(errorsSince(owner, fromAgain)[0]).toContain('Already executed.')
      const job = jobsOf(server).list()[0]!
      expect(
        jobsOf(server)
          .invocations(job.id)
          .filter((i) => i.tool === 'delete_task')
          .map((i) => i.outcome),
      ).toEqual(['approval_required', 'ok'])
    })

    it("the user's own tap needs no approval (the tap is the explicit action)", async () => {
      const id = await addTaskViaUi(server, user, 'Tap-delete me')
      invokeTool(user, 'delete_task', { id })
      await waitFor(user.received, () => !titles(server).includes('Tap-delete me'))
    })
  })

  describe('AT-14: long job', () => {
    it('taps stay fast while a job runs; progress then completion are visible', async () => {
      const pause = hold()
      agent.queue([
        { type: 'toolCall', callId: 'l1', name: 'add_task', args: { title: 'Plan: draft notes' } },
        pause.event,
        { type: 'toolCall', callId: 'l2', name: 'add_task', args: { title: 'Plan: send notes' } },
        { type: 'text', text: 'Planned 2 tasks.' },
        { type: 'done' },
      ])
      const from = user.received.length
      chat(user, 'todo', 'plan the release notes')
      const running = await waitFor(user.received, () => {
        const r = jobsView(user, from)?.running[0]
        return r?.detail.includes('1 tool call') ? r : undefined
      })
      expect(running.detail).toMatch(/^running · 1 tool call · add_task/)
      expect(running.can_cancel).toBe(true)

      // The agent is mid-turn; a deterministic tap on the same app is not queued behind it.
      const t0 = Date.now()
      await addTaskViaUi(server, user, 'Tapped during the job')
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(jobsOf(server).list({ states: ['RUNNING'] })).toHaveLength(1)

      pause.release()
      await waitFor(user.received, () =>
        jobsView(user)
          ?.recent.find((r) => r.id === running.id)
          ?.detail.startsWith('done'),
      )
      expect(titles(server)).toEqual(
        expect.arrayContaining(['Plan: draft notes', 'Plan: send notes']),
      )
      await waitFor(user.received, () =>
        chatTexts(user, ChatRole.ASSISTANT, from).includes('Planned 2 tasks.'),
      )
    })

    it('cancel stops the job; the completed step is not undone', async () => {
      const pause = hold()
      agent.queue([
        { type: 'toolCall', callId: 'c1', name: 'add_task', args: { title: 'Cancel: step one' } },
        pause.event,
        { type: 'toolCall', callId: 'c2', name: 'add_task', args: { title: 'Cancel: step two' } },
        { type: 'done' },
      ])
      const from = user.received.length
      chat(user, 'todo', 'do two steps slowly')
      const jobId = (
        await waitFor(user.received, () => {
          const r = jobsView(user, from)?.running[0]
          return r?.detail.includes('1 tool call') ? r : undefined
        })
      ).id
      invokeTool(user, 'cancel_job', { job_id: jobId }, 'jobs')
      await waitFor(user.received, () => jobsOf(server).get(jobId)?.state === 'CANCELED')
      expect(titles(server)).toContain('Cancel: step one')
      expect(titles(server)).not.toContain('Cancel: step two')
      pause.release()
    })

    it('a failing job shows FAILED with its error', async () => {
      agent.queue([{ type: 'error', message: 'model overloaded' }])
      const from = user.received.length
      chat(user, 'todo', 'this will fail')
      const row = await waitFor(user.received, () => {
        const r = jobsView(user, from)?.recent[0]
        return r?.detail.startsWith('failed') ? r : undefined
      })
      expect(row.detail).toContain('model overloaded')
      expect(row.can_retry).toBe(true)
    })
  })

  describe('AT-15: reconnect', () => {
    // A device that has not chatted yet (turn rate limit: 5 per 30 s per session).
    it('a client that was away gets the result and job state once', async () => {
      const pause = hold()
      agent.queue([
        pause.event,
        { type: 'text', text: 'Finished while you were away.' },
        { type: 'done' },
      ])
      chat(other, 'todo', 'take your time')
      await waitFor(other.received, () => jobsOf(server).list({ states: ['RUNNING'] }).length === 1)
      other.close()

      pause.release()
      await waitFor([], () => jobsOf(server).list()[0]?.state === 'SUCCEEDED')

      const back = await connectTo(server.port, 'todo', OTHER)
      other = back
      // Snapshot: the chat window carries the result row exactly once…
      const window = await waitFor(back.received, () =>
        back.received.find(
          (m) => m.payload.case === 'chatWindow' && m.payload.value.scope === 'app:todo',
        ),
      )
      if (window.payload.case !== 'chatWindow') throw new Error('unreachable')
      const hits = window.payload.value.entries.filter(
        (e) => e.text === 'Finished while you were away.',
      )
      expect(hits).toHaveLength(1)
      const ids = window.payload.value.entries.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
      // …and the Agent Jobs face shows the finished job with a unique, ordered event log.
      const view = await waitFor(back.received, () => jobsView(back))
      expect(view.recent[0]!.detail).toMatch(/^done/)
      const seqs = view.events.map((e) => e.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect([...seqs].sort((a, b) => b - a)).toEqual(seqs)
    }, 15_000)
  })
})

describe('AT-16: restart', () => {
  it('an interrupted job needs recovery; retry repeats nothing; approvals survive', async () => {
    // ---- server A: a job adds a task, then the process dies mid-turn.
    const agentA = new SpyAgentAdapter()
    const a = await startServer(['todo'], opts(agentA))
    pair(a)
    const ca = await connectTo(a.port, 'todo', USER)
    const victimId = await addTaskViaUi(a, ca, 'Old receipts')
    // A pending approval that must survive the restart.
    agentA.queue([
      { type: 'toolCall', callId: 'r0', name: 'delete_task', args: { id: victimId } },
      { type: 'done' },
    ])
    chat(ca, 'todo', 'delete old receipts')
    await waitFor(ca.received, () => jobsOf(a).list()[0]?.state === 'WAITING_FOR_APPROVAL')

    agentA.queue([
      { type: 'toolCall', callId: 'r1', name: 'add_task', args: { title: 'Buy milk' } },
      hold().event, // never released: the server stops here
      { type: 'done' },
    ])
    chat(ca, 'todo', 'add buy milk')
    await waitFor(ca.received, () => titles(a).includes('Buy milk'))
    ca.close()
    await a.stop()

    // ---- server B on the same home.
    const agentB = new SpyAgentAdapter()
    const b = await startServer(['todo'], opts(agentB), a.home)
    try {
      const jobs = jobsOf(b)
      const interrupted = jobs.list({ states: ['RECOVERY_REQUIRED'] })
      expect(interrupted).toHaveLength(1)
      expect(interrupted[0]!.errorMessage).toContain(
        'Interrupted by a server restart. Completed before that: add_task.',
      )
      expect(jobs.list({ states: ['WAITING_FOR_APPROVAL'] })).toHaveLength(1)

      const cb = await connectTo(b.port, 'todo', USER)
      const view = await waitFor(cb.received, () => jobsView(cb))
      expect(view.recent[0]).toMatchObject({ id: interrupted[0]!.id, can_retry: true })
      expect(view.recent[0]!.detail).toMatch(/^needs recovery/)
      expect(view.approvals).toHaveLength(1)

      // Retry: the agent does the same thing again; the completed write is not repeated.
      agentB.queue([
        { type: 'toolCall', callId: 'r2', name: 'add_task', args: { title: 'Buy milk' } },
        { type: 'text', text: 'Added.' },
        { type: 'done' },
      ])
      invokeTool(cb, 'retry_job', { job_id: interrupted[0]!.id }, 'jobs')
      await waitFor(
        cb.received,
        () =>
          jobs.list()[0]?.retryOf === interrupted[0]!.id && jobs.list()[0]?.state === 'SUCCEEDED',
      )
      expect(titles(b).filter((t) => t === 'Buy milk')).toHaveLength(1)
      expect(agentB.toolResults.at(-1)?.result).toMatchObject({ already_done: true })
      const retry = jobs.list()[0]!
      expect(jobs.invocations(retry.id).map((i) => i.outcome)).toEqual(['deduplicated'])
      expect(retry.rootRequestId).toBe(interrupted[0]!.rootRequestId)

      // The approval filed before the restart still works.
      const approvalId = view.approvals[0]!.id
      invokeTool(cb, 'respond_approval', { approval_id: approvalId, decision: 'approve' }, 'jobs')
      await waitFor(cb.received, () => !titles(b).includes('Old receipts'))
      cb.close()
    } finally {
      await b.stop()
    }
  }, 30_000)
})
