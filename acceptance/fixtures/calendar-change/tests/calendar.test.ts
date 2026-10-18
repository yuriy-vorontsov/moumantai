import { describe, it, expect } from 'vitest'
import { resolve } from '../faces/calendar/calendar.resolve.js'
import addTask from '../tools/add-task.js'
import completeTask from '../tools/complete-task.js'
import { addDaysIso, getTodayUtc } from '../utils/dates.js'
import { freshDb, run } from './helpers.js'

describe('calendar face', () => {
  it('groups the next 14 days by date, pending before done, undated excluded', async () => {
    const db = freshDb()
    const today = getTodayUtc()
    await run(addTask, db, { title: 'Later', due_date: addDaysIso(today, 3) })
    const done = await run(addTask, db, { title: 'Done today', due_date: today })
    await run(addTask, db, { title: 'Due today', due_date: today, priority: 'high' })
    await run(addTask, db, { title: 'Someday' })
    await run(addTask, db, { title: 'Too far', due_date: addDaysIso(today, 20) })
    await run(completeTask, db, { id: (done.result as { id: string }).id })

    const view = resolve({ db })
    expect(view.tasks.map((t) => t.title)).toEqual(['Due today', 'Done today', 'Later'])
    expect(view.tasks.map((t) => t.show_day_header)).toEqual([true, false, true])
    expect(view.summary).toMatchObject({ total_count: 3, is_empty: false })
  })
})
