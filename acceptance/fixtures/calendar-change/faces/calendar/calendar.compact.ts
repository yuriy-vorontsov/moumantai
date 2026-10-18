import { defineFace } from 'moumantai'
import { scaffold, column, list, listItem, pathRef, sectionHeader, emptyState } from 'moumantai/ui'
import { resolve } from './calendar.resolve.js'

/**
 * Compact (watch) Calendar face.
 *
 * Shows all tasks with due dates in the next 14 days as a flat list.
 * The supporting text shows the day label so the date context is always
 * visible even without section headers (avoids dense nesting on small screens).
 * Completed tasks surface with a check_circle icon; pending tasks show their
 * priority icon. Read-only — no tap action.
 */
export default defineFace({
  id: 'calendar',
  label: 'Calendar',
  position: 5,
  kind: 'compact',
  viewToolDescription: 'Show tasks scheduled in the next 14 days, grouped by date.',
  resolve,
  components: [
    scaffold('root', { body: 'content' }),
    column('content', ['range_hdr', 'calendar_list', 'empty_msg'], { spacing: 8 }),
    ...sectionHeader('range_hdr', pathRef('/summary/range_label')),
    list('calendar_list', '/tasks', 'cal_row'),
    listItem('cal_row', pathRef('$.title'), {
      supporting: pathRef('$.day_label'),
      leading_icon: pathRef('$.row_icon'),
    }),
    ...emptyState('empty_msg', 'No tasks scheduled', {
      visible: pathRef('/summary/is_empty'),
    }),
  ],
})
