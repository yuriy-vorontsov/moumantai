/**
 * View model for the home app's Release History face (mutabl spec §13.1):
 * one row per release, newest first, grouped by app. Apps that were never
 * published through the release workflow still get a row with their running
 * version so the user can always see what is active.
 */

import type { ReleasesView, ReleaseRowView } from '../apps/home/faces/releases.js'
import type { ReleaseStore } from './store.js'
import { restoreIncompatibility } from './publish.js'

export interface ReleasesViewDeps {
  store: ReleaseStore
  /** Installed apps (excluding home), in display order. */
  apps: () => { id: string; name: string; version: string }[]
  liveDbPath: (appId: string) => string
}

/** Server time is all we know here (no client time zone), so say it is UTC. */
function day(ts: string | null | undefined): string {
  return ts ? `${ts.replace('T', ' ').slice(0, 16)} UTC` : ''
}

export function buildReleasesView(deps: ReleasesViewDeps): ReleasesView {
  const rows: ReleaseRowView[] = []
  let published = 0
  for (const app of deps.apps()) {
    const history = deps.store.list(app.id)
    if (history.length === 0) {
      rows.push({
        id: `unreleased:${app.id}`,
        title: `${app.name} ${app.version}`,
        detail: 'active · not published through a draft yet',
        is_active: true,
        can_restore: false,
      })
      continue
    }
    published++
    for (const r of history) {
      const isActive = r.status === 'active'
      const parts: string[] = [isActive ? 'active' : 'previous']
      if (r.source === 'baseline') {
        parts.push('baseline (before the first published change)')
      } else {
        const run = r.validationRunId ? deps.store.getRun(r.validationRunId) : undefined
        parts.push(run ? (run.ok ? 'checks passed' : 'checks failed') : 'checks not recorded')
      }
      parts.push(day(r.activatedAt ?? r.createdAt))
      let canRestore = false
      if (!isActive) {
        const reason = restoreIncompatibility({
          target: r,
          liveDbPath: deps.liveDbPath(app.id),
          allReleases: history,
        })
        canRestore = reason === null
        if (reason) parts.push(`cannot restore: ${reason}`)
      }
      rows.push({
        id: r.id,
        title: `${app.name} ${r.version}`,
        detail: parts.filter(Boolean).join(' · '),
        is_active: isActive,
        can_restore: canRestore,
      })
    }
  }
  const headline =
    rows.length === 0
      ? 'No apps installed'
      : published === 0
        ? 'No published changes yet. Approved drafts appear here as releases.'
        : `${published} app${published === 1 ? '' : 's'} with release history. Restore reactivates an earlier version; your data is kept.`
  return { rows, summary: { is_empty: rows.length === 0, headline } }
}
