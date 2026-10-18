import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sql } from 'drizzle-orm'
import { ChangeRequestStore } from '../../../src/server/change-requests/store.js'
import {
  REQUEST_CHANGE_TOOL,
  synthesizeChangeRequestTool,
} from '../../../src/server/agent/synthesize-change-request-tool.js'
import { ConversationStore } from '../../../src/server/conversations/store.js'
import { freshPlatformDb, type PlatformDb } from '../../helpers/face-params-fixtures.js'

let db: PlatformDb
let store: ChangeRequestStore

beforeEach(() => {
  db = freshPlatformDb()
  store = new ChangeRequestStore(db)
})

describe('ChangeRequestStore', () => {
  it('numbers requests and de-duplicates an identical active request per app', () => {
    const a = store.create({ appId: 'todo', request: 'Add a calendar view' })
    const again = store.create({ appId: 'todo', request: '  add a   CALENDAR view ' })
    const other = store.create({ appId: 'spend-tracker', request: 'Add a calendar view' })
    expect(a.existing).toBe(false)
    expect(again).toMatchObject({ existing: true, changeRequest: { id: a.changeRequest.id } })
    expect([a.changeRequest.number, other.changeRequest.number]).toEqual([1, 2])
    expect(store.listActive('todo')).toHaveLength(1)
  })

  it('links open requests to a draft, then completes them on promote', () => {
    store.create({ appId: 'todo', request: 'A' })
    store.create({ appId: 'todo', request: 'B' })
    store.create({ appId: 'other', request: 'C' })
    const linked = store.linkToDraft('todo', 'draft-1')
    expect(linked.map((cr) => cr.request)).toEqual(['A', 'B'])
    expect(linked.every((cr) => cr.status === 'in_progress' && cr.draftId === 'draft-1')).toBe(true)
    store.completeDraft('draft-1')
    expect(store.listActive('todo')).toHaveLength(0)
    expect(store.listAll().filter((cr) => cr.status === 'done')).toHaveLength(2)
  })

  it('returns requests to open when the draft is discarded', () => {
    store.create({ appId: 'todo', request: 'A' })
    store.linkToDraft('todo', 'draft-1')
    store.releaseDraft('draft-1')
    expect(store.listActive('todo')).toMatchObject([{ status: 'open', draftId: null }])
  })

  it('rejects only active requests', () => {
    const { changeRequest } = store.create({ appId: 'todo', request: 'A' })
    expect(store.reject(changeRequest.number)).toBe(true)
    expect(store.reject(changeRequest.number)).toBe(false)
    expect(store.getByNumber(changeRequest.number)?.status).toBe('rejected')
  })
})

describe(`${REQUEST_CHANGE_TOOL} tool`, () => {
  it('records the request with its origin and notifies once', async () => {
    const created: number[] = []
    const tool = synthesizeChangeRequestTool({
      appId: 'todo',
      store,
      onCreated: (cr) => created.push(cr.number),
    })
    const ctx = { db: {} as never, conversationId: 'conv-1', originDeviceId: 'dev-1' }
    const first = await tool.execute({ ...ctx, params: { request: 'Add a calendar view' } })
    const second = await tool.execute({ ...ctx, params: { request: 'add a calendar view' } })
    expect(first.result).toMatchObject({ change_request: 1, already_requested: false })
    expect(second.result).toMatchObject({ change_request: 1, already_requested: true })
    expect(created).toEqual([1])
    expect(store.listActive('todo')[0]).toMatchObject({
      originDeviceId: 'dev-1',
      conversationId: 'conv-1',
    })
  })

  it('requires a request text', async () => {
    const tool = synthesizeChangeRequestTool({ appId: 'todo', store })
    expect((await tool.execute({ db: {} as never, params: { request: ' ' } })).error).toBe(
      'request is required',
    )
  })
})

describe('migration 0015 (owner role)', () => {
  it('grandfathers already-paired devices as owner; new devices default to user', () => {
    const all = path.resolve(__dirname, '../../../drizzle/platform')
    const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-mig-'))
    fs.mkdirSync(path.join(partial, 'meta'))
    const journal = JSON.parse(fs.readFileSync(path.join(all, 'meta', '_journal.json'), 'utf8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 14)
    fs.writeFileSync(path.join(partial, 'meta', '_journal.json'), JSON.stringify(journal))
    for (const e of journal.entries) {
      fs.copyFileSync(path.join(all, `${e.tag}.sql`), path.join(partial, `${e.tag}.sql`))
    }

    const old = drizzle({ connection: ':memory:', casing: 'snake_case' })
    migrate(old, { migrationsFolder: partial })
    old.run(sql`INSERT INTO devices (device_id, paired, last_seen_at, created_at)
      VALUES ('paired-before', 1, '2026-01-01', '2026-01-01'),
             ('pending-before', 0, '2026-01-01', '2026-01-01')`)
    migrate(old, { migrationsFolder: all })

    const store = new ConversationStore(old as never)
    expect(store.isDeviceOwner('paired-before')).toBe(true)
    expect(store.isDeviceOwner('pending-before')).toBe(false)
    store.setDevicePaired('new-device', true)
    expect(store.isDeviceOwner('new-device')).toBe(false)
    expect(store.setDeviceRole('new-device', 'owner')).toBe(true)
    expect(store.isDeviceOwner('new-device')).toBe(true)
  })
})
