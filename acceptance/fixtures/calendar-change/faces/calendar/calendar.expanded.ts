import { defineFace } from 'moumantai'
import { scaffold, topBar, column, text, pathRef, emptyState } from 'moumantai/ui'
import { resolve } from './calendar.resolve.js'
import { calendarCardRowTemplate } from './calendar.parts.js'

/**
 * Expanded (phone) Calendar face.
 *
 * Shows tasks for the next 14 days grouped by date, one section per day that
 * has tasks. Completed tasks appear with a "Done" chip; pending high-priority
 * tasks show a "High" chip. Undated tasks are excluded. Read-only — no
 * add-task chip or filter controls.
 */
export default defineFace({
  id: 'calendar',
  label: 'Calendar',
  position: 5,
  kind: 'expanded',
  viewToolDescription:
    'Show tasks scheduled in the next 14 days, grouped by date with day section headers.',
  resolve,
  components: [
    scaffold('root', { body: 'content', top_bar: 'top' }),
    topBar('top', 'Calendar'),
    column('content', ['range_label', 'calendar_list', 'empty_msg'], {
      spacing: 16,
      padding: 16,
    }),
    text('range_label', pathRef('/summary/range_label'), { typography: 'titleMedium' }),
    ...calendarCardRowTemplate(),
    ...emptyState('empty_msg', 'No tasks scheduled in the next 14 days', {
      visible: pathRef('/summary/is_empty'),
    }),
  ],
})
