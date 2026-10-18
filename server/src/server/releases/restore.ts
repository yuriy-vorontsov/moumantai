/**
 * Restore = reactivate an earlier release of an app (mutabl spec §7.6).
 * Data is never rolled back: a release is restorable only when it can run on
 * the current schema (see restoreIncompatibility). The live DB is backed up
 * first anyway, and the switch is the same atomic pointer swap as publish.
 */

import type { ReleaseStore } from './store.js'
import type { Release } from './schema.js'
import { backupDatabase, restoreIncompatibility, switchPointer, verifyArtifact } from './publish.js'

export interface RestoreDeps {
  home: string
  store: ReleaseStore
  liveDbPath: (appId: string) => string
  /**
   * Activate the app from its pointer. Omitted when the server is not running
   * this process (CLI): the pointer switch then takes effect on next start.
   */
  activate?: (appId: string) => Promise<void>
  principal: string
}

export type RestoreOutcome =
  | { ok: true; release: Release; activated: boolean }
  | { ok: false; error: string }

/** Reactivate `target` (a release id, or `<version>`) of `appId`. */
export async function restoreRelease(
  deps: RestoreDeps,
  appId: string,
  target: string,
): Promise<RestoreOutcome> {
  const release = deps.store.get(target) ?? deps.store.byVersion(appId, target)
  if (!release || release.appId !== appId) {
    return { ok: false, error: `no release "${target}" for ${appId}` }
  }
  const active = deps.store.active(appId)
  if (active?.id === release.id) {
    return { ok: false, error: `${appId} ${release.version} is already the active release` }
  }
  try {
    verifyArtifact(release)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const liveDb = deps.liveDbPath(appId)
  const incompatible = restoreIncompatibility({
    target: release,
    liveDbPath: liveDb,
    allReleases: deps.store.list(appId),
  })
  if (incompatible) return { ok: false, error: incompatible }

  backupDatabase(deps.home, appId, liveDb, `restore-${release.version}`)
  const previous = switchPointer(deps.home, appId, release.artifactDir)
  let activated = false
  if (deps.activate) {
    try {
      await deps.activate(appId)
      activated = true
    } catch (err) {
      if (previous) switchPointer(deps.home, appId, previous)
      if (previous) await deps.activate(appId).catch(() => undefined)
      return {
        ok: false,
        error: `restore of ${release.version} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  deps.store.markActive(appId, release.id)
  deps.store.event({
    subjectType: 'release',
    subjectId: release.id,
    appId,
    state: 'RESTORED',
    actor: deps.principal,
    detail: active ? `replaced ${active.version}` : undefined,
  })
  return { ok: true, release: deps.store.get(release.id)!, activated }
}
