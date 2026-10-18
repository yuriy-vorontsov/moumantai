/**
 * Release History (mutabl spec §13.1): the active version of every app, its
 * earlier releases with their validation status, and a Restore action.
 *
 * Data comes from the release store via `setReleasesView`, wired by the
 * server at boot (the home app has no DB of its own for this). Restore calls
 * the UI-only `restore_release` tool, which the server gates to owners.
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
} from 'moumantai/ui'

export interface ReleaseRowView {
  id: string
  title: string
  detail: string
  is_active: boolean
  can_restore: boolean
}

export interface ReleasesView {
  rows: ReleaseRowView[]
  summary: { is_empty: boolean; headline: string }
}

let provideView: () => ReleasesView = () => ({
  rows: [],
  summary: { is_empty: true, headline: 'No releases yet' },
})

/** Called by the server once its release store exists. */
export function setReleasesView(provider: () => ReleasesView): void {
  provideView = provider
}

export default defineFace({
  id: 'releases',
  label: 'Releases',
  position: 1,
  viewToolDescription: 'Show the published releases of every app and which one is active.',
  components: [
    scaffold('root', { body: 'content', top_bar: 'top' }),
    topBar('top', 'Releases'),
    column('content', ['headline', 'release_list'], { spacing: 12, padding: 16 }),
    text('headline', pathRef('/summary/headline'), { typography: 'bodyMedium' }),
    list('release_list', '/rows', 'release_card'),
    card('release_card', ['release_row']),
    row('release_row', ['release_text', 'restore_button'], {
      spacing: 12,
      vertical_alignment: 'center',
    }),
    column('release_text', ['release_title', 'release_detail'], { spacing: 2, weight: 1 }),
    text('release_title', pathRef('$.title'), { typography: 'titleSmall' }),
    text('release_detail', pathRef('$.detail'), { typography: 'bodySmall' }),
    button('restore_button', 'Restore', {
      visible: pathRef('$.can_restore'),
      action: invokeTool('restore_release', { release_id: pathRef('$.id') }),
    }),
  ],
  resolve: () => ({ ...provideView() }),
})
