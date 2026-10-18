/**
 * Phase 3 acceptance (spec §15, §7): the draft → validate → preview → review
 * → publish → restore workflow against the real server, the real Task
 * Manager (`apps/todo` 0.2.0) and the real release pipeline (sandboxed tests
 * included). The Developer Agent's edits are the recorded output of a real
 * edit-agent run (fixtures/changes.ts), applied inside the agent turn.
 *
 *   AT-05  Generate a feature  → a Calendar view is built in a draft workspace.
 *   AT-06  Preview changes     → the owner uses it; the active release, other
 *                                devices and live data are unaffected.
 *   AT-07  Reject draft        → active release and data remain unchanged.
 *   AT-09  Invalid build       → a failing test prevents publication.
 *   AT-20  Version contracts   → an incompatible manifest or migration is
 *                                rejected with a clear error.
 *   AT-08  Publish             → the validated, approved release becomes
 *                                active; the UI shows its version.
 *   AT-10  Restore             → the prior compatible release is restored;
 *                                data stays consistent.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { create } from '@bufbuild/protobuf'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import {
  ChatKind,
  ChatRole,
  ClientMessageSchema,
  DraftStatus,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'
import { tasks } from '../../apps/todo/schema.js'
import { ReleaseStore } from '../../server/src/server/releases/store.js'
import { contentHash } from '../../server/src/server/releases/hash.js'
import { draftPaths } from '../../server/src/server/workspace/home.js'
import {
  SpyAgentAdapter,
  TestClient,
  chat,
  connectTo,
  invokeTool,
  startServer,
  waitFor,
  type RunningServer,
} from '../helpers.js'
import {
  addCalendarFace,
  addDestructiveMigration,
  addFailingTest,
  bumpVersion,
  requireEngine,
  rewordAddTask,
} from '../fixtures/changes.js'

const OWNER = 'acceptance-owner-device-000000000003'
const USER = 'acceptance-user-device-0000000000004'
// A device holds one session at a time, so the home screens use their own devices.
const OWNER_HOME = 'acceptance-owner-device-000000000005'
const USER_HOME = 'acceptance-user-device-0000000000006'

let server: RunningServer
let owner: TestClient
let user: TestClient
const agent = new SpyAgentAdapter()

beforeAll(async () => {
  server = await startServer(['todo'], {
    adapterOverride: agent,
    pairingRequired: true,
    devModeEnabled: true,
  })
  const store = server.components.store
  store.setDevicePaired(OWNER, true)
  store.setDeviceRole(OWNER, 'owner')
  store.setDevicePaired(USER, true)
  store.setDevicePaired(OWNER_HOME, true)
  store.setDeviceRole(OWNER_HOME, 'owner')
  store.setDevicePaired(USER_HOME, true)
  owner = await connectTo(server.port, 'todo', OWNER)
  user = await connectTo(server.port, 'todo', USER)
}, 30_000)

afterAll(async () => {
  owner?.close()
  user?.close()
  await server.stop()
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const releases = () => new ReleaseStore(server.components.platformDb)
const liveSource = () => path.join(server.home, 'apps-src', 'todo')
const liveVersion = () => server.components.appEngine.getApp('todo')!.manifest.version
const liveFaceIds = () =>
  server.components.appEngine
    .getApp('todo')!
    .faceRegistry.list()
    .map((f) => f.id)

const liveDb = () => server.components.appEngine.getApp('todo')!.db
const liveTitles = (): string[] =>
  liveDb()
    .select()
    .from(tasks)
    .all()
    .map((t) => t.title)
    .sort()

/** The newest faceList for `appId` a client received after index `from`. */
function lastFaceList(c: TestClient, appId: string, from = 0): string[] | undefined {
  for (let i = c.received.length - 1; i >= from; i--) {
    const m = c.received[i]!
    if (m.payload.case === 'faceList' && m.payload.value.appId === appId) {
      return m.payload.value.faces.map((f) => f.faceId)
    }
  }
  return undefined
}

/**
 * Owner asks the Developer Agent for a change in Developer Mode. The spy agent
 * applies `apply` to the draft worktree during the turn; the server then
 * reloads the preview. Resolves with the draft id once the preview is ready.
 */
async function developerTurn(request: string, apply: (dir: string) => void): Promise<string> {
  const from = owner.received.length
  agent.queueEdit(apply)
  chat(owner, 'todo', request, true)
  const reloaded = await waitFor(
    owner.received,
    (buf) => {
      const replied = buf.findIndex(
        (m, i) =>
          i >= from &&
          m.payload.case === 'chat' &&
          m.payload.value.kind === ChatKind.DEV &&
          m.payload.value.role === ChatRole.ASSISTANT,
      )
      if (replied < 0) return undefined
      return buf.find(
        (m, i): m is ServerMessage & { payload: { case: 'draftStateChanged' } } =>
          i > replied &&
          m.payload.case === 'draftStateChanged' &&
          (m.payload.value.status === DraftStatus.UPDATED ||
            m.payload.value.status === DraftStatus.FAILED),
      )
    },
    20_000,
  )
  expect(reloaded.payload.value.errorMessage ?? '').toBe('')
  return reloaded.payload.value.draft!.draftId
}

/** Send a draft action and wait for its DraftActionResult. */
async function draftAction(
  kind: 'draftPromote' | 'draftDiscard',
  draftId: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; error?: string }> {
  const from = owner.received.length
  owner.send(create(ClientMessageSchema, { payload: { case: kind, value: { draftId } } }))
  const res = await waitFor(
    owner.received,
    (buf) =>
      buf.find(
        (m, i) =>
          i >= from &&
          m.payload.case === 'draftActionResult' &&
          m.payload.value.draftId === draftId,
      ),
    timeoutMs,
  )
  if (res.payload.case !== 'draftActionResult') throw new Error('unreachable')
  return {
    ok: res.payload.value.ok,
    ...(res.payload.value.error ? { error: res.payload.value.error } : {}),
  }
}

/** Latest Release History rows the given home client received. */
function releaseRows(c: TestClient): Array<Record<string, unknown>> | undefined {
  for (let i = c.received.length - 1; i >= 0; i--) {
    const m = c.received[i]!
    if (
      m.payload.case === 'faceUpdate' &&
      m.payload.value.appId === 'home' &&
      m.payload.value.faceId === 'releases'
    ) {
      return (m.payload.value.data?.rows ?? []) as Array<Record<string, unknown>>
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------

let liveHashBefore: string

describe('AT-05/06/07: build a feature in a draft, preview it, reject it', () => {
  let draftId: string

  it('AT-05: the Developer Agent builds a Calendar view in a draft workspace, not in the active release', async () => {
    invokeTool(user, 'add_task', {
      title: 'Pay rent',
      due_date: new Date().toISOString().slice(0, 10),
    })
    await waitFor(user.received, () => liveTitles().includes('Pay rent'))
    liveHashBefore = contentHash(fs.realpathSync(liveSource()))

    draftId = await developerTurn(
      'Add a calendar view of my tasks for the next two weeks',
      addCalendarFace,
    )

    const draftDir = draftPaths(server.home, draftId).dir
    expect(agent.turns.at(-1)!.cwd).toBe(draftDir)
    expect(fs.existsSync(path.join(draftDir, 'faces', 'calendar', 'calendar.resolve.ts'))).toBe(
      true,
    )
    const draft = server.components.draftRegistry!.get(draftId)!
    expect(draft.appDef.manifest.version).toBe('0.3.0')
    expect(draft.booted.faceRegistry.list().map((f) => f.id)).toContain('calendar')

    // The active release is untouched.
    expect(liveVersion()).toBe('0.2.0')
    expect(liveFaceIds()).not.toContain('calendar')
    expect(contentHash(fs.realpathSync(liveSource()))).toBe(liveHashBefore)
  })

  it('AT-06: the owner previews and uses the Calendar; other devices and live data are unaffected', async () => {
    // The initiating owner session is opted into the preview automatically.
    await waitFor(owner.received, () => lastFaceList(owner, 'todo')?.includes('calendar'))
    expect(lastFaceList(user, 'todo')).not.toContain('calendar')

    // The preview Calendar renders the live data snapshot (shadow DB clone).
    const calendar = await waitFor(owner.received, (buf) =>
      [...buf]
        .reverse()
        .find((m) => m.payload.case === 'faceUpdate' && m.payload.value.faceId === 'calendar'),
    )
    if (calendar.payload.case !== 'faceUpdate') throw new Error('unreachable')
    expect(JSON.stringify(calendar.payload.value.data)).toContain('Pay rent')

    // Acting in the preview writes to the draft's shadow DB only.
    const from = owner.received.length
    invokeTool(
      owner,
      'add_task',
      { title: 'Preview-only task', due_date: new Date().toISOString().slice(0, 10) },
      'calendar',
    )
    await waitFor(owner.received, (buf) =>
      buf.some(
        (m, i) =>
          i >= from &&
          m.payload.case === 'faceUpdate' &&
          JSON.stringify(m.payload.value.data).includes('Preview-only task'),
      ),
    )
    const shadow = new Database(draftPaths(server.home, draftId).shadowDbFile, { readonly: true })
    const inShadow = shadow
      .prepare(`SELECT count(*) AS n FROM tasks WHERE title = 'Preview-only task'`)
      .get() as { n: number }
    shadow.close()
    expect(inShadow.n).toBe(1)
    expect(liveTitles()).toEqual(['Pay rent'])
    expect(
      user.received.some(
        (m) =>
          m.payload.case === 'faceUpdate' &&
          JSON.stringify(m.payload.value.data).includes('Preview-only task'),
      ),
    ).toBe(false)
  })

  it('AT-07: rejecting the draft leaves the active release and data unchanged', async () => {
    const res = await draftAction('draftDiscard', draftId)
    expect(res).toEqual({ ok: true })

    expect(fs.existsSync(draftPaths(server.home, draftId).dir)).toBe(false)
    expect(server.components.draftRegistry!.get(draftId)).toBeUndefined()
    expect(liveVersion()).toBe('0.2.0')
    expect(liveFaceIds()).not.toContain('calendar')
    expect(contentHash(fs.realpathSync(liveSource()))).toBe(liveHashBefore)
    expect(liveTitles()).toEqual(['Pay rent'])
    expect(releases().list('todo')).toEqual([])
    // The rejection is recorded against the draft.
    const states = releases()
      .events('draft', draftId)
      .map((e) => e.state)
    expect(states).toEqual(expect.arrayContaining(['DRAFTING', 'DISCARDED']))
    await waitFor(
      owner.received,
      () => lastFaceList(owner, 'todo') && !lastFaceList(owner, 'todo')!.includes('calendar'),
    )
  })
})

/** Build a draft with `apply`, try to publish it, expect a block, then discard. */
async function expectBlocked(request: string, apply: (dir: string) => void): Promise<string> {
  const draftId = await developerTurn(request, apply)
  const res = await draftAction('draftPromote', draftId)
  expect(res.ok).toBe(false)
  // Still a draft: nothing published, the active release untouched.
  expect(server.components.draftRegistry!.get(draftId)).toBeDefined()
  expect(liveVersion()).toBe('0.2.0')
  expect(contentHash(fs.realpathSync(liveSource()))).toBe(liveHashBefore)
  expect(releases().list('todo')).toEqual([])
  expect(await draftAction('draftDiscard', draftId)).toEqual({ ok: true })
  return res.error ?? ''
}

describe('AT-09: invalid build', () => {
  it('a failing test prevents publication and the report names it', async () => {
    const error = await expectBlocked('Add a calendar view (with a broken test)', (dir) => {
      addCalendarFace(dir)
      addFailingTest(dir)
    })
    expect(error).toMatch(/^Publication blocked — 0\.2\.0 → 0\.3\.0/)
    expect(error).toMatch(/✗ tests: .*fail/)
    expect(error).toMatch(/✓ types/)
  }, 180_000)
})

describe('AT-20: version contracts', () => {
  it('rejects a release that does not bump the version', async () => {
    const error = await expectBlocked('Calendar without a version bump', (dir) =>
      addCalendarFace(dir, { bump: false }),
    )
    expect(error).toMatch(/✗ manifest: .*version/)
  }, 180_000)

  it('rejects a manifest that needs a newer Moumantai', async () => {
    const error = await expectBlocked('Calendar for a newer engine', (dir) => {
      addCalendarFace(dir)
      requireEngine(dir, '9.0.0')
    })
    expect(error).toMatch(
      /incompatible: the app requires Moumantai >= 9\.0\.0; this server is \d+\.\d+\.\d+/,
    )
  }, 180_000)

  it('rejects a destructive migration', async () => {
    const error = await expectBlocked('Drop task notes', (dir) => {
      bumpVersion(dir, '0.2.0', '0.3.0')
      addDestructiveMigration(dir)
    })
    expect(error).toMatch(/✗ migrations: .*0002_drop_notes/)
  }, 180_000)
})

describe('AT-08/10: publish, then restore', () => {
  let home: TestClient

  it('AT-08: the validated, approved Calendar release becomes active and the UI shows its version', async () => {
    const draftId = await developerTurn(
      'Add a calendar view of my tasks for the next two weeks',
      addCalendarFace,
    )
    const from = user.received.length
    const res = await draftAction('draftPromote', draftId)
    expect(res).toEqual({ ok: true })

    // Active: 0.3.0 from the draft; the pre-release source kept as a baseline.
    const history = releases().list('todo')
    expect(history.map((r) => [r.version, r.source, r.status])).toEqual([
      ['0.3.0', 'draft', 'active'],
      ['0.2.0', 'baseline', 'superseded'],
    ])
    const active = history[0]!
    expect(active.approvalId).toBeTruthy()
    expect(releases().getRun(active.validationRunId!)?.ok).toBe(true)
    expect(fs.realpathSync(liveSource())).toBe(fs.realpathSync(active.artifactDir))
    expect(liveVersion()).toBe('0.3.0')
    expect(
      releases()
        .events('draft', draftId)
        .map((e) => e.state),
    ).toEqual(expect.arrayContaining(['APPROVED', 'VALIDATING', 'PUBLISHING', 'PUBLISHED']))

    // Every device now gets the Calendar, rendering live data.
    await waitFor(user.received, () => lastFaceList(user, 'todo', from)?.includes('calendar'))
    expect(liveTitles()).toEqual(['Pay rent'])

    // The Release History face shows the active version.
    home = await connectTo(server.port, 'home', OWNER_HOME)
    const rows = await waitFor(home.received, () => releaseRows(home))
    expect(rows.map((r) => [r.title, r.is_active, r.can_restore])).toEqual([
      ['Todo 0.3.0', true, false],
      ['Todo 0.2.0', false, true],
    ])
  }, 180_000)

  it('AT-10: a non-owner cannot restore; the owner restores 0.2.0 and data stays consistent', async () => {
    // Data written on 0.3.0 must survive the restore.
    invokeTool(user, 'add_task', { title: 'Written on 0.3.0' })
    await waitFor(user.received, () => liveTitles().includes('Written on 0.3.0'))
    const baseline = releases()
      .list('todo')
      .find((r) => r.source === 'baseline')!

    const userHome = await connectTo(server.port, 'home', USER_HOME)
    try {
      const from = userHome.received.length
      invokeTool(userHome, 'restore_release', { release_id: baseline.id }, 'releases')
      const denied = await waitFor(userHome.received, (buf) =>
        buf.find((m, i) => i >= from && m.payload.case === 'error'),
      )
      if (denied.payload.case !== 'error') throw new Error('unreachable')
      expect(denied.payload.value.message).toContain('Only the owner can restore a release.')
      expect(liveVersion()).toBe('0.3.0')
    } finally {
      userHome.close()
    }

    const from = user.received.length
    invokeTool(home, 'restore_release', { release_id: baseline.id }, 'releases')
    await waitFor(home.received, () => releaseRows(home)?.[0]?.is_active === false)

    expect(releases().active('todo')?.id).toBe(baseline.id)
    expect(liveVersion()).toBe('0.2.0')
    expect(fs.realpathSync(liveSource())).toBe(fs.realpathSync(baseline.artifactDir))
    expect(contentHash(baseline.artifactDir)).toBe(liveHashBefore)
    await waitFor(user.received, () => {
      const faces = lastFaceList(user, 'todo', from)
      return faces && !faces.includes('calendar')
    })
    // Data is consistent: nothing lost, nothing rolled back.
    expect(liveTitles()).toEqual(['Pay rent', 'Written on 0.3.0'])
    expect(
      liveDb().select().from(tasks).where(eq(tasks.title, 'Pay rent')).get()?.due_date,
    ).toBeTruthy()

    expect(releaseRows(home)!.map((r) => [r.title, r.is_active, r.can_restore])).toEqual([
      ['Todo 0.3.0', false, true],
      ['Todo 0.2.0', true, false],
    ])
    expect(
      releases()
        .events('release', baseline.id)
        .map((e) => [e.state, e.actor]),
    ).toContainEqual(['RESTORED', OWNER_HOME])
    home.close()
  }, 60_000)
})

describe('publish of a modified file at an unchanged path', () => {
  it('the live tool is the published one (fresh bundle, no stale module)', async () => {
    const text = 'Add a task (reworded in a published release).'
    const draftId = await developerTurn('Reword the add_task description', (dir) => {
      rewordAddTask(dir, text)
      bumpVersion(dir, '0.2.0', '0.3.1')
    })
    expect(await draftAction('draftPromote', draftId)).toEqual({ ok: true })
    // Let any file-watcher event settle (debounce 300 ms) before checking.
    await new Promise((r) => setTimeout(r, 1500))
    const live = server.components.appEngine.getApp('todo')!
    expect(live.manifest.version).toBe('0.3.1')
    expect(live.toolRegistry.get('add_task')!.description).toBe(text)
  }, 180_000)
})
