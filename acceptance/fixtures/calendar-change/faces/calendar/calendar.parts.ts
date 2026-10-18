import { text, list, card, row, column, chip, pathRef } from 'moumantai/ui'
import type { ComponentDef } from 'moumantai/ui'

/**
 * Phone row template for Calendar.
 *
 * Each row is a small column whose first child is a day header `text` gated by
 * `visible: $.show_day_header` — same flat-list + inline-header pattern used
 * by the Upcoming face. Avoids nested lists.
 *
 * The trailing chip shows "Done" (selected style) for completed tasks or the
 * priority label (filled only for high) for pending tasks.
 */
export function calendarCardRowTemplate(): ComponentDef[] {
  return [
    list('calendar_list', '/tasks', 'cal_row'),
    column('cal_row', ['cal_day_header', 'cal_row_card'], { spacing: 8 }),
    text('cal_day_header', pathRef('$.day_header_label'), {
      typography: 'titleSmall',
      visible: pathRef('$.show_day_header'),
      padding: { top: 8 },
    }),
    card('cal_row_card', ['cal_row_inner']),
    row('cal_row_inner', ['cal_col', 'cal_status_chip'], {
      vertical_alignment: 'center',
      spacing: 12,
    }),
    column('cal_col', ['cal_title'], { spacing: 2, weight: 1 }),
    text('cal_title', pathRef('$.title'), { typography: 'bodyLarge' }),
    chip('cal_status_chip', pathRef('$.status_chip_label'), {
      selected: pathRef('$.is_done'),
      visible: pathRef('$.show_status_chip'),
    }),
  ]
}
