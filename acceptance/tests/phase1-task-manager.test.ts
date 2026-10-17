/**
 * Phase 1 acceptance (spec §15): AT-02, AT-03, AT-04 against the real server
 * with only the Task Manager (`apps/todo`) installed, driven through the real
 * WebSocket protocol.
 *
 *   AT-02  Create task with UI  → stored through the shared tool; no AI call.
 *   AT-03  Create task with AI  → agent invokes the same tool; result matches UI state.
 *   AT-04  Offline UI           → no credential: server boots, CRUD works, chat explains.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import type { ServerMessage } from '@moumantai/protocol/generated/moumantai/v1'
import { ChatRole } from '@moumantai/protocol/generated/moumantai/v1'
import { tasks } from '../../apps/todo/schema.js'
import {
  UnavailableAgentAdapter,
  AGENT_UNAVAILABLE_MESSAGE,
} from '../../server/src/server/agent/unavailable/adapter.js'
import {
  SpyAgentAdapter,
  chat,
  connectTo,
  invokeTool,
  startServer,
  waitFor,
  type RunningServer,
} from '../helpers.js'

const TODAY = new Date().toISOString().slice(0, 10)

type TaskRow = typeof tasks.$inferSelect

async function todoDb(server: RunningServer) {
  return (await server.components.appEngine.use('todo')).db
}

/** Wait until a task with `title` exists and return it. */
async function rowByTitle(
  server: RunningServer,
  buf: ServerMessage[],
  title: string,
): Promise<TaskRow> {
  const db = await todoDb(server)
  return waitFor(buf, () => db.select().from(tasks).where(eq(tasks.title, title)).get())
}

/** Latest `today` face read model the client received that lists `title`. */
function todayRowFor(buf: ServerMessage[], title: string): Record<string, unknown> | false {
  for (let i = buf.length - 1; i >= 0; i--) {
    const m = buf[i]!
    if (m.payload.case !== 'faceUpdate' || m.payload.value.faceId !== 'today') continue
    const rows = (m.payload.value.data?.today_tasks ?? []) as Array<Record<string, unknown>>
    const row = rows.find((r) => r.title === title)
    if (row) return row
  }
  return false
}

/** Comparable task fields — everything except identity and timestamps. */
function content(row: TaskRow) {
  const { id: _id, title: _title, createdAt: _c, updatedAt: _u, ...rest } = row
  return rest
}

function readModel(row: Record<string, unknown>) {
  const { id: _id, title: _title, ...rest } = row
  return rest
}

describe('with an agent available', () => {
  let server: RunningServer
  const agent = new SpyAgentAdapter()

  beforeAll(async () => {
    server = await startServer(['todo'], { adapterOverride: agent })
  }, 20_000)

  afterAll(async () => {
    await server.stop()
  })

  it('AT-02: the phone UI has a create form that calls add_task with every field', async () => {
    const c = await connectTo(server.port, 'todo')
    try {
      const compose = await waitFor(c.received, (buf) =>
        buf.find((m) => m.payload.case === 'faceUpdate' && m.payload.value.faceId === 'compose'),
      )
      if (compose.payload.case !== 'faceUpdate') throw new Error('unreachable')
      const button = compose.payload.value.components.find((cd) => cd.id === 'add_button')
      const wire = JSON.stringify(button)
      expect(wire).toContain('"tool":"add_task"')
      for (const field of ['new_title', 'new_notes', 'new_due', 'new_priority', 'new_project']) {
        expect(wire).toContain(`/$form/${field}`)
      }
      // No escalation prompt: a submit never hands off to the agent by design.
      expect(wire).not.toContain('escalation')
    } finally {
      c.close()
    }
  })

  it('AT-02: the create form stores the task through add_task without calling the agent', async () => {
    const c = await connectTo(server.port, 'todo')
    try {
      const title = 'AT-02 via form'
      invokeTool(c, 'add_task', {
        title,
        notes: '',
        due_date: TODAY,
        priority: 'high',
        project_id: '',
      })

      const row = await rowByTitle(server, c.received, title)
      expect(content(row)).toEqual({
        priority: 'high',
        due_date: TODAY,
        notes: null,
        completed_at: null,
        project_id: null,
      })
      // The UI read model reflects it…
      await waitFor(c.received, (buf) => todayRowFor(buf, title))
      // …and no agent turn ran.
      expect(agent.turns).toHaveLength(0)
    } finally {
      c.close()
    }
  })

  it('AT-03: the agent creates a task through the same tool, matching the UI result', async () => {
    const c = await connectTo(server.port, 'todo')
    try {
      const uiTitle = 'AT-03 parity via form'
      const aiTitle = 'AT-03 parity via agent'
      const fields = { due_date: TODAY, priority: 'high', notes: 'same input' }

      invokeTool(c, 'add_task', { title: uiTitle, ...fields })
      const uiRow = await rowByTitle(server, c.received, uiTitle)

      agent.queue([
        {
          type: 'toolCall',
          callId: 'call-1',
          name: 'add_task',
          args: { title: aiTitle, ...fields },
        },
        { type: 'text', text: 'Added.' },
        { type: 'done' },
      ])
      chat(c, 'todo', `add "${aiTitle}" for today, high priority`)
      const aiRow = await rowByTitle(server, c.received, aiTitle)

      expect(agent.turns).toHaveLength(1)
      expect(agent.turns[0]!.tools.map((t) => t.name)).toContain('add_task')
      expect(agent.toolResults.at(-1)).toMatchObject({ result: { success: true, id: aiRow.id } })
      // Same stored state…
      expect(content(aiRow)).toEqual(content(uiRow))
      // …and the same read-model row on the Today face.
      const uiView = await waitFor(c.received, (buf) => todayRowFor(buf, uiTitle))
      const aiView = await waitFor(c.received, (buf) => todayRowFor(buf, aiTitle))
      expect(readModel(aiView)).toEqual(readModel(uiView))
    } finally {
      c.close()
    }
  })

  it('AT-03: UI and agent calls are rejected by the same validation', async () => {
    const c = await connectTo(server.port, 'todo')
    try {
      const bad = { title: 'AT-03 invalid', priority: 'urgent' }
      invokeTool(c, 'add_task', bad)
      const uiError = await waitFor(c.received, (buf) =>
        buf.find((m) => m.payload.case === 'error' && m.payload.value.message.includes('priority')),
      )

      agent.queue([
        { type: 'toolCall', callId: 'call-2', name: 'add_task', args: bad },
        { type: 'done' },
      ])
      chat(c, 'todo', 'add an urgent task')
      const aiResult = await waitFor(c.received, () =>
        agent.toolResults.find((r) => r.error?.includes('priority')),
      )

      if (uiError.payload.case !== 'error') throw new Error('unreachable')
      expect(uiError.payload.value.message).toBe(`[tool_validation] ${aiResult.error}`)
      const db = await todoDb(server)
      expect(db.select().from(tasks).where(eq(tasks.title, bad.title)).all()).toHaveLength(0)
    } finally {
      c.close()
    }
  })
})

describe('AT-04: no LLM credential', () => {
  const CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
  const saved: Record<string, string | undefined> = {}
  let server: RunningServer

  beforeAll(async () => {
    for (const k of CREDENTIAL_VARS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    server = await startServer(['todo'], { backend: 'claude', anthropicApiKey: undefined })
  }, 20_000)

  afterAll(async () => {
    await server.stop()
    for (const k of CREDENTIAL_VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('boots without an agent', () => {
    expect(server.components.adapter).toBeInstanceOf(UnavailableAgentAdapter)
  })

  it('create, update, complete and delete all work from the UI', async () => {
    const c = await connectTo(server.port, 'todo')
    try {
      const db = await todoDb(server)
      invokeTool(c, 'add_task', { title: 'AT-04 offline', due_date: TODAY, priority: 'low' })
      const created = await rowByTitle(server, c.received, 'AT-04 offline')

      invokeTool(c, 'update_task', {
        id: created.id,
        title: 'AT-04 offline edited',
        priority: 'high',
      })
      await rowByTitle(server, c.received, 'AT-04 offline edited')

      invokeTool(c, 'complete_task', { id: created.id }, 'today')
      await waitFor(
        c.received,
        () => db.select().from(tasks).where(eq(tasks.id, created.id)).get()?.completed_at,
      )

      invokeTool(c, 'delete_task', { id: created.id }, 'today')
      await waitFor(
        c.received,
        () => db.select().from(tasks).where(eq(tasks.id, created.id)).get() === undefined,
      )
    } finally {
      c.close()
    }
  })

  it('chat answers with a clear "agent unavailable" message', async () => {
    const c = await connectTo(server.port, 'todo')
    try {
      chat(c, 'todo', 'add a task to buy milk')
      const reply = await waitFor(c.received, (buf) =>
        buf.find((m) => m.payload.case === 'chat' && m.payload.value.role === ChatRole.ASSISTANT),
      )
      if (reply.payload.case !== 'chat') throw new Error('unreachable')
      expect(reply.payload.value.text).toBe(AGENT_UNAVAILABLE_MESSAGE)
    } finally {
      c.close()
    }
  })
})
