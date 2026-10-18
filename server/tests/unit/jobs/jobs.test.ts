import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openPlatformDb } from '../../../src/server/db/platform-db.js'
import { ensureHomeLayout } from '../../../src/server/workspace/home.js'
import {
  JobStore,
  IllegalTransitionError,
  boundedJson,
  canonicalJson,
} from '../../../src/server/jobs/store.js'
import { createJobToolGate } from '../../../src/server/jobs/tool-gate.js'
import { JobService, type JobServiceDeps } from '../../../src/server/jobs/service.js'
import { buildJobsView } from '../../../src/server/jobs/view.js'
import type { ToolDefinition } from '../../../src/server/agent/types.js'
import type { Job } from '../../../src/server/jobs/schema.js'

let home: string
let platformDb: ReturnType<typeof openPlatformDb>
let store: JobStore
const db = {} as never

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mou-jobs-'))
  ensureHomeLayout(home)
  platformDb = openPlatformDb(home)
  store = new JobStore(platformDb)
})

afterEach(() => {
  ;(platformDb as unknown as { $client: Database.Database }).$client.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: name,
  parameters: {},
  execute: async () => ({ result: { ok: true } }),
  ...extra,
})

function newJob(over: Partial<Parameters<JobStore['create']>[0]> = {}): Job {
  return store.create({
    kind: 'user_turn',
    appId: 'todo',
    scope: 'app:todo',
    conversationId: 'conv-1',
    principal: 'dev-A',
    requestId: 'req-1',
    messageId: 'msg-1',
    summary: 'tidy up my tasks',
    ...over,
  })
}

describe('JobStore', () => {
  it('follows the spec §9.1 state machine and rejects illegal transitions', () => {
    const job = newJob()
    expect(job.state).toBe('QUEUED')
    expect(store.transition(job.id, 'RUNNING').startedAt).toBeTruthy()
    store.transition(job.id, 'WAITING_FOR_APPROVAL')
    store.transition(job.id, 'RUNNING')
    const done = store.transition(job.id, 'SUCCEEDED')
    expect(done.finishedAt).toBeTruthy()
    expect(() => store.transition(job.id, 'RUNNING')).toThrow(IllegalTransitionError)
    expect(() => store.transition(newJob().id, 'SUCCEEDED')).toThrow(/QUEUED → SUCCEEDED/)
  })

  it('numbers events with one monotonic sequence across jobs and replays after a seq', () => {
    const a = newJob()
    const b = newJob({ requestId: 'req-2' })
    store.event(a.id, 'tool.started', { tool: 'x' })
    const mark = store.lastSeq()
    store.event(b.id, 'tool.started', { tool: 'y' })
    store.event(a.id, 'tool.finished', { tool: 'x', ok: true })
    const after = store.eventsAfter(mark)
    expect(after.map((e) => [e.jobId === a.id ? 'a' : 'b', e.type])).toEqual([
      ['b', 'tool.started'],
      ['a', 'tool.finished'],
    ])
    expect(after[0]!.seq).toBeLessThan(after[1]!.seq)
    expect(store.eventsAfter(mark, { jobId: a.id })).toHaveLength(1)
  })

  it('bounds payloads and canonicalizes arguments', () => {
    expect(JSON.parse(boundedJson({ text: 'x'.repeat(5000) }))).toMatchObject({ truncated: true })
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    )
  })

  it('a retry inherits the root request id and counts retries', () => {
    const first = newJob()
    const retry = newJob({ requestId: 'req-retry', retryOf: first })
    expect(retry).toMatchObject({ rootRequestId: 'req-1', retryOf: first.id, retryCount: 1 })
  })
})

describe('job tool gate', () => {
  it('files an approval instead of running a destructive tool', async () => {
    const job = newJob()
    const onApproval = vi.fn()
    const gate = createJobToolGate({ store, job, onApprovalRequested: onApproval })
    const del = tool('delete_task', {
      risk: 'destructive',
      approvalSummary: () => 'Delete task “Pay rent”',
    })
    const res = await gate.before({
      name: 'delete_task',
      args: { id: 't1' },
      tool: del,
      appId: 'todo',
      db,
    })
    expect(res?.result).toMatchObject({
      status: 'approval_required',
      action: 'Delete task “Pay rent”',
    })
    expect(onApproval).toHaveBeenCalledOnce()
    expect(store.approvals({ jobId: job.id, statuses: ['pending'] })).toHaveLength(1)
    expect(store.invocations(job.id).map((i) => i.outcome)).toEqual(['approval_required'])
  })

  it('does not repeat a write that an earlier attempt of the same request completed', async () => {
    const add = tool('add_task')
    const call = { name: 'add_task', args: { title: 'Milk' }, tool: add, appId: 'todo', db }

    const first = newJob()
    const g1 = createJobToolGate({ store, job: first })
    expect(await g1.before(call)).toBeUndefined() // runs
    g1.after(call, { result: { id: 'task-1' } })

    const retry = newJob({ requestId: 'req-retry', retryOf: first })
    const g2 = createJobToolGate({ store, job: retry })
    const res = await g2.before({ ...call })
    expect(res?.result).toMatchObject({ id: 'task-1', already_done: true })
    // A second identical call in the retry was not in the first attempt → runs.
    expect(await g2.before({ ...call })).toBeUndefined()
    // Reads are never deduplicated.
    const q = tool('query_tasks', { risk: 'read' })
    expect(
      await g2.before({ name: 'query_tasks', args: {}, tool: q, appId: 'todo', db }),
    ).toBeUndefined()
  })

  it('records denied calls', () => {
    const job = newJob()
    createJobToolGate({ store, job }).denied('Bash')
    expect(store.invocations(job.id)[0]).toMatchObject({ tool: 'Bash', outcome: 'denied' })
  })
})

describe('JobService', () => {
  function service(over: Partial<JobServiceDeps> = {}) {
    const notes: string[] = []
    const ran: string[] = []
    const svc = new JobService({
      store,
      isOwner: (d) => d === 'owner-dev',
      runApprovedTool: async (a) => {
        ran.push(a.tool)
        return { result: { deleted: true } }
      },
      postNote: (_c, text) => notes.push(text),
      rerunUserTurn: async () => {},
      requestText: () => 'tidy up',
      notify: () => {},
      ...over,
    })
    return { svc, notes, ran }
  }

  async function jobWaitingForApproval(svc: JobService) {
    const job = svc.create({
      kind: 'user_turn',
      appId: 'todo',
      scope: 'app:todo',
      conversationId: 'conv-1',
      principal: 'dev-A',
      requestId: 'r1',
      summary: 'delete the rent task',
    })
    svc.begin(job.id)
    const del = tool('delete_task', {
      risk: 'destructive',
      approvalSummary: () => 'Delete task “Rent”',
    })
    await svc
      .gateFor(job)
      .before({ name: 'delete_task', args: { id: 't1' }, tool: del, appId: 'todo', db })
    svc.finish(job.id, { ok: true })
    return { job: store.get(job.id)!, approval: store.approvals({ jobId: job.id })[0]! }
  }

  it('a turn that asked for approval ends WAITING_FOR_APPROVAL; approve runs it once', async () => {
    const { svc, notes, ran } = service()
    const { job, approval } = await jobWaitingForApproval(svc)
    expect(job.state).toBe('WAITING_FOR_APPROVAL')
    expect(notes[0]).toContain('Waiting for your approval: Delete task “Rent”')

    expect(await svc.respondApproval(approval.id, 'approve', 'dev-B')).toMatchObject({ ok: false })
    expect(await svc.respondApproval(approval.id, 'approve', 'dev-A')).toMatchObject({ ok: true })
    expect(await svc.respondApproval(approval.id, 'approve', 'dev-A')).toMatchObject({
      ok: false,
      error: 'Already executed.',
    })
    expect(ran).toEqual(['delete_task'])
    expect(store.get(job.id)!.state).toBe('SUCCEEDED')
    expect(store.getApproval(approval.id)!.status).toBe('executed')
  })

  it('reject cancels the job and runs nothing; the owner may decide too', async () => {
    const { svc, ran } = service()
    const { job, approval } = await jobWaitingForApproval(svc)
    expect(await svc.respondApproval(approval.id, 'reject', 'owner-dev')).toMatchObject({
      ok: true,
    })
    expect(ran).toEqual([])
    expect(store.get(job.id)).toMatchObject({ state: 'CANCELED', errorCode: 'rejected' })
  })

  it('cancel: queued jobs never run; a waiting job rejects its approvals', async () => {
    const { svc } = service()
    const queued = svc.create({
      kind: 'user_turn',
      appId: 'todo',
      scope: 'app:todo',
      conversationId: 'c',
      principal: 'dev-A',
      requestId: 'q',
      summary: 's',
    })
    expect(svc.cancel(queued.id, 'dev-B')).toMatchObject({ ok: false })
    expect(svc.cancel(queued.id, 'dev-A')).toMatchObject({ ok: true })
    expect(svc.begin(queued.id)).toBeNull()
    expect(store.get(queued.id)!.state).toBe('CANCELED')

    const { job, approval } = await jobWaitingForApproval(svc)
    expect(svc.cancel(job.id, 'dev-A')).toMatchObject({ ok: true })
    expect(store.get(job.id)!.state).toBe('CANCELED')
    expect(store.getApproval(approval.id)!.status).toBe('rejected')
  })

  it('cancel of a running job aborts only that job', () => {
    const { svc } = service()
    const job = svc.create({
      kind: 'user_turn',
      appId: 'todo',
      scope: 'app:todo',
      conversationId: 'c',
      principal: 'dev-A',
      requestId: 'r',
      summary: 's',
    })
    const signal = svc.begin(job.id)!
    svc.cancel(job.id, 'owner-dev')
    expect(signal.aborted).toBe(true)
    svc.finish(job.id, { ok: false, errorCode: 'aborted' })
    expect(store.get(job.id)!.state).toBe('CANCELED')
  })

  it('restart: running jobs need recovery and list what completed; approvals survive', async () => {
    const { svc } = service()
    const { job: waiting } = await jobWaitingForApproval(svc)
    const running = svc.create({
      kind: 'user_turn',
      appId: 'todo',
      scope: 'app:todo',
      conversationId: 'c',
      principal: 'dev-A',
      requestId: 'r2',
      summary: 'add milk',
    })
    svc.begin(running.id)
    const add = tool('add_task')
    const g = svc.gateFor(running)
    const call = { name: 'add_task', args: { title: 'Milk' }, tool: add, appId: 'todo', db }
    await g.before(call)
    g.after(call, { result: { id: 'x' } })

    // A new process: fresh service over the same store.
    expect(service().svc.recoverOnStartup()).toEqual({ interrupted: 1 })
    expect(store.get(running.id)).toMatchObject({
      state: 'RECOVERY_REQUIRED',
      errorCode: 'server_interrupted',
    })
    expect(store.get(running.id)!.errorMessage).toContain('Completed before that: add_task')
    expect(store.get(waiting.id)!.state).toBe('WAITING_FOR_APPROVAL')
  })

  it('retry re-runs the original request for the principal or an owner only', async () => {
    const rerun = vi.fn(async () => {})
    const { svc } = service({ rerunUserTurn: rerun })
    const job = svc.create({
      kind: 'user_turn',
      appId: 'todo',
      scope: 'app:todo',
      conversationId: 'c',
      principal: 'dev-A',
      requestId: 'r',
      summary: 's',
    })
    svc.begin(job.id)
    svc.finish(job.id, { ok: false, errorCode: 'timeout' })
    expect(await svc.retry(job.id, 'dev-B')).toMatchObject({ ok: false })
    expect(await svc.retry(job.id, 'dev-A')).toMatchObject({ ok: true })
    expect(rerun).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), 'tidy up', 'dev-A')
  })
})

describe('Agent Jobs view', () => {
  it('shows approvals, running and recent jobs and the event log', async () => {
    const job = newJob()
    store.transition(job.id, 'RUNNING')
    const del = tool('delete_task', {
      risk: 'destructive',
      approvalSummary: () => 'Delete task “Rent”',
    })
    await createJobToolGate({ store, job }).before({
      name: 'delete_task',
      args: { id: 't' },
      tool: del,
      appId: 'todo',
      db,
    })
    const failed = newJob({ requestId: 'r9', summary: 'plan the week' })
    store.transition(failed.id, 'RUNNING')
    store.transition(failed.id, 'FAILED', { errorCode: 'timeout' })

    const view = buildJobsView(store, (id) => (id === 'todo' ? 'Todo' : id))
    expect(view.summary).toMatchObject({ pending_approvals: 1, has_approvals: true })
    expect(view.approvals[0]).toMatchObject({ title: 'Delete task “Rent”' })
    expect(view.running[0]!.title).toBe('Todo · Chat: tidy up my tasks')
    expect(view.recent[0]).toMatchObject({ can_retry: true })
    expect(view.events[0]!.line).toMatch(/^#\d+ · /)
  })
})
