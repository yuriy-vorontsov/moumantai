import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openPlatformDb } from '../../../src/server/db/platform-db.js'
import { ensureHomeLayout } from '../../../src/server/workspace/home.js'
import { ReleaseStore } from '../../../src/server/releases/store.js'
import {
  createArtifact,
  ensureBaseline,
  pointerPath,
  restoreIncompatibility,
  switchPointer,
  verifyArtifact,
} from '../../../src/server/releases/publish.js'
import { restoreRelease } from '../../../src/server/releases/restore.js'
import { buildReleasesView } from '../../../src/server/releases/view.js'

let home: string
let platformDb: ReturnType<typeof openPlatformDb>
let store: ReleaseStore
let liveDb: string

/** An app source dir with optional drizzle journal entries `[when, tag]`. */
function makeSource(
  name: string,
  files: Record<string, string>,
  journal?: [number, string][],
): string {
  const dir = path.join(home, 'src', name)
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  if (journal) {
    fs.mkdirSync(path.join(dir, 'drizzle', 'meta'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'drizzle', 'meta', '_journal.json'),
      JSON.stringify({ entries: journal.map(([when, tag]) => ({ when, tag })) }),
    )
  }
  return dir
}

/** Live DB whose __drizzle_migrations records the given `when`s as applied. */
function applyMigrations(whens: number[]): void {
  const db = new Database(liveDb)
  db.exec(
    'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash text, created_at numeric)',
  )
  db.exec('DELETE FROM __drizzle_migrations')
  for (const w of whens)
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('h', w)
  db.close()
}

function publish(version: string, src: string, opts: { additive?: string[] } = {}) {
  const artifact = createArtifact(home, 'todo', version, src)
  const r = store.insert({
    appId: 'todo',
    version,
    contentHash: artifact.contentHash,
    schemaTag: null,
    source: 'draft',
    artifactDir: artifact.artifactDir,
    migrationPlan: opts.additive ? JSON.stringify({ added: opts.additive, additive: true }) : null,
  })
  switchPointer(home, 'todo', artifact.artifactDir)
  store.markActive('todo', r.id)
  return r
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mou-releases-'))
  ensureHomeLayout(home)
  platformDb = openPlatformDb(home)
  store = new ReleaseStore(platformDb)
  liveDb = path.join(home, 'live.sqlite')
})

afterEach(() => {
  ;(platformDb as unknown as { $client: Database.Database }).$client.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('artifacts + pointer', () => {
  it('an artifact is verified by content hash; tampering is detected', () => {
    const src = makeSource('v1', { 'index.ts': 'export {}' })
    const a = createArtifact(home, 'todo', '0.2.0', src)
    const r = store.insert({
      appId: 'todo',
      version: '0.2.0',
      contentHash: a.contentHash,
      source: 'draft',
      artifactDir: a.artifactDir,
    })
    expect(() => verifyArtifact(r)).not.toThrow()
    fs.writeFileSync(path.join(a.artifactDir, 'index.ts'), 'export const evil = 1')
    expect(() => verifyArtifact(r)).toThrow(/modified after publication/)
    fs.rmSync(a.artifactDir, { recursive: true })
    expect(() => verifyArtifact(r)).toThrow(/missing/)
  })

  it('switchPointer moves a pre-release real dir aside, then swaps symlinks and returns the previous target', () => {
    const link = pointerPath(home, 'todo')
    fs.mkdirSync(link, { recursive: true })
    fs.writeFileSync(path.join(link, 'index.ts'), 'old')
    const a = makeSource('a', { 'index.ts': 'a' })
    const b = makeSource('b', { 'index.ts': 'b' })

    const movedTo = switchPointer(home, 'todo', a)!
    expect(fs.readFileSync(path.join(movedTo, 'index.ts'), 'utf8')).toBe('old')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(link, 'index.ts'), 'utf8')).toBe('a')

    expect(switchPointer(home, 'todo', b)).toBe(a)
    expect(fs.readFileSync(path.join(link, 'index.ts'), 'utf8')).toBe('b')
  })

  it('ensureBaseline captures the running source once and makes it the active release', () => {
    fs.mkdirSync(pointerPath(home, 'todo'), { recursive: true })
    fs.writeFileSync(path.join(pointerPath(home, 'todo'), 'index.ts'), 'v0.2.0')
    const base = ensureBaseline({ home, appId: 'todo', version: '0.2.0', schemaTag: null, store })
    expect(base).toMatchObject({ source: 'baseline', status: 'active', version: '0.2.0' })
    expect(fs.realpathSync(pointerPath(home, 'todo'))).toBe(fs.realpathSync(base.artifactDir))
    expect(
      ensureBaseline({ home, appId: 'todo', version: '0.2.0', schemaTag: null, store }).id,
    ).toBe(base.id)
    expect(store.list('todo')).toHaveLength(1)
  })
})

describe('restore compatibility', () => {
  it('compatible when later migrations came from an additive release', () => {
    const v1 = publish('0.2.0', makeSource('v1', { 'index.ts': '1' }, [[100, '0000_init']]))
    publish(
      '0.3.0',
      makeSource('v2', { 'index.ts': '2' }, [
        [100, '0000_init'],
        [200, '0001_projects'],
      ]),
      {
        additive: ['0001_projects'],
      },
    )
    applyMigrations([100, 200])
    expect(
      restoreIncompatibility({ target: v1, liveDbPath: liveDb, allReleases: store.list('todo') }),
    ).toBeNull()
  })

  it('incompatible when a later migration is not known to be additive', () => {
    const v1 = publish('0.2.0', makeSource('v1', { 'index.ts': '1' }, [[100, '0000_init']]))
    publish(
      '0.3.0',
      makeSource('v2', { 'index.ts': '2' }, [
        [100, '0000_init'],
        [200, '0001_drop'],
      ]),
    )
    applyMigrations([100, 200])
    expect(
      restoreIncompatibility({ target: v1, liveDbPath: liveDb, allReleases: store.list('todo') }),
    ).toMatch(/0001_drop.*not known to be backward-compatible/)
  })

  it('incompatible when the target expects migrations the live data does not have', () => {
    const v2 = publish(
      '0.3.0',
      makeSource('v2', { 'index.ts': '2' }, [
        [100, '0000_init'],
        [200, '0001_projects'],
      ]),
    )
    applyMigrations([100])
    expect(
      restoreIncompatibility({ target: v2, liveDbPath: liveDb, allReleases: store.list('todo') }),
    ).toMatch(/expects migrations that are not applied.*0001_projects/)
  })
})

describe('restoreRelease', () => {
  function twoReleases() {
    const v1 = publish('0.2.0', makeSource('v1', { 'index.ts': '1' }, [[100, '0000_init']]))
    const v2 = publish(
      '0.3.0',
      makeSource('v2', { 'index.ts': '2' }, [
        [100, '0000_init'],
        [200, '0001_projects'],
      ]),
      {
        additive: ['0001_projects'],
      },
    )
    applyMigrations([100, 200])
    return { v1, v2 }
  }

  it('switches the pointer, activates, records the event; data is untouched', async () => {
    const { v1, v2 } = twoReleases()
    const activated: string[] = []
    const out = await restoreRelease(
      {
        home,
        store,
        liveDbPath: () => liveDb,
        activate: async (id) => void activated.push(id),
        principal: 'owner-1',
      },
      'todo',
      '0.2.0',
    )
    expect(out).toMatchObject({ ok: true, activated: true })
    expect(activated).toEqual(['todo'])
    expect(store.active('todo')?.id).toBe(v1.id)
    expect(store.get(v2.id)?.status).toBe('superseded')
    expect(fs.readFileSync(path.join(pointerPath(home, 'todo'), 'index.ts'), 'utf8')).toBe('1')
    expect(store.events('release', v1.id).map((e) => [e.state, e.actor])).toContainEqual([
      'RESTORED',
      'owner-1',
    ])
    // A backup was taken; live migrations stay applied (no data rollback).
    expect(
      fs
        .readdirSync(path.join(home, 'backups', 'todo'))
        .some((f) => f.includes('before-restore-0.2.0')),
    ).toBe(true)
    const db = new Database(liveDb, { readonly: true })
    expect(
      (db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n,
    ).toBe(2)
    db.close()
  })

  it('rolls the pointer back when activation fails', async () => {
    const { v2 } = twoReleases()
    let calls = 0
    const out = await restoreRelease(
      {
        home,
        store,
        liveDbPath: () => liveDb,
        activate: async () => {
          if (calls++ === 0) throw new Error('boot failed')
        },
        principal: 'owner-1',
      },
      'todo',
      '0.2.0',
    )
    expect(out).toMatchObject({ ok: false })
    expect(out.ok === false && out.error).toMatch(/rolled back: boot failed/)
    expect(store.active('todo')?.id).toBe(v2.id)
    expect(fs.readFileSync(path.join(pointerPath(home, 'todo'), 'index.ts'), 'utf8')).toBe('2')
  })

  it('refuses the active release, unknown versions, and incompatible targets', async () => {
    twoReleases()
    const deps = { home, store, liveDbPath: () => liveDb, principal: 'cli' }
    expect(await restoreRelease(deps, 'todo', '0.3.0')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already the active/),
    })
    expect(await restoreRelease(deps, 'todo', '9.9.9')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no release/),
    })
    applyMigrations([100, 200, 300]) // a migration nobody vouched for
    expect(await restoreRelease(deps, 'todo', '0.2.0')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not compatible/),
    })
  })
})

describe('Release History view', () => {
  it('lists releases newest first; only compatible previous releases are restorable', () => {
    const { v1 } = (() => {
      const v1 = publish('0.2.0', makeSource('v1', { 'index.ts': '1' }, [[100, '0000_init']]))
      publish(
        '0.3.0',
        makeSource('v2', { 'index.ts': '2' }, [
          [100, '0000_init'],
          [200, '0001_projects'],
        ]),
        {
          additive: ['0001_projects'],
        },
      )
      applyMigrations([100, 200])
      return { v1 }
    })()
    const view = buildReleasesView({
      store,
      apps: () => [
        { id: 'todo', name: 'Todo', version: '0.3.0' },
        { id: 'notes', name: 'Notes', version: '1.0.0' },
      ],
      liveDbPath: () => liveDb,
    })
    expect(view.rows.map((r) => [r.title, r.is_active, r.can_restore])).toEqual([
      ['Todo 0.3.0', true, false],
      ['Todo 0.2.0', false, true],
      ['Notes 1.0.0', true, false],
    ])
    expect(view.rows[1]!.id).toBe(v1.id)
    expect(view.rows[2]!.detail).toMatch(/not published/)
    expect(view.summary.is_empty).toBe(false)
  })
})
