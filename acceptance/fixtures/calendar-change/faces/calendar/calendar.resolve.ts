import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, asc, gte, isNotNull, lte } from 'drizzle-orm'
import { tasks } from '../../schema.js'
import { addDaysIso, dayLabel, getTodayUtc, weekRangeLabel } from '../../utils/dates.js'
import { priorityRowFields, rankPriority } from '../../utils/priority.js'

/**
 * Resolver for the Calendar face.
 *
 * Returns all tasks (pending + completed) whose due_date falls within
 * today..today+13 (14 days inclusive). Undated tasks are excluded.
 * Tasks are grouped by date; within each day, pending tasks sort before
 * completed ones, and within each sub-group they sort by priority.
 */
export function resolve({ db }: { db: BetterSQLite3Database }) {
  const today = getTodayUtc()
  const tomorrow = addDaysIso(today, 1)
  const end = addDaysIso(today, 13) // today through today+13 = 14 days inclusive

  const rows = db
    .select()
    .from(tasks)
    .where(and(isNotNull(tasks.due_date), gte(tasks.due_date, today), lte(tasks.due_date, end)))
    .orderBy(asc(tasks.due_date))
    .all()

  // Group by day.
  const byDay = new Map<string, typeof rows>()
  for (const t of rows) {
    const k = t.due_date!
    const bucket = byDay.get(k) ?? []
    bucket.push(t)
    byDay.set(k, bucket)
  }

  const sortedDayKeys = [...byDay.keys()].sort()

  const tasksOut: Array<Record<string, unknown>> = []

  for (const k of sortedDayKeys) {
    const dayTasks = byDay.get(k)!

    // Pending first (by priority), then completed (by priority).
    dayTasks.sort((a, b) => {
      const aDone = a.completed_at != null ? 1 : 0
      const bDone = b.completed_at != null ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      return rankPriority(a.priority) - rankPriority(b.priority)
    })

    const label = `${dayLabel(k, today, tomorrow)} · ${dayTasks.length}`

    dayTasks.forEach((t, i) => {
      const isDone = t.completed_at != null
      const pFields = priorityRowFields(t.priority)
      tasksOut.push({
        id: t.id,
        title: t.title,
        priority: t.priority,
        due_date: t.due_date!,
        is_done: isDone,
        // row_icon: checkmark for done tasks, priority icon for pending.
        row_icon: isDone ? 'check_circle' : pFields.priority_icon,
        day_label: dayLabel(k, today, tomorrow),
        show_day_header: i === 0,
        day_header_label: i === 0 ? label : '',
        // status chip: "Done" for completed; priority chip for pending.
        status_chip_label: isDone ? 'Done' : pFields.priority_chip_label,
        show_status_chip: isDone || pFields.show_priority_chip,
        ...pFields,
      })
    })
  }

  const totalCount = tasksOut.length

  return {
    summary: {
      total_count: totalCount,
      range_label: weekRangeLabel(today, end),
      has_tasks: totalCount > 0,
      is_empty: totalCount === 0,
    },
    tasks: tasksOut,
  }
}
