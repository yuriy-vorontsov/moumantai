/**
 * Platform-DB `change_requests`: capability requests raised in User Mode
 * (via the synthesized `request_app_change` tool) for the owner to build in
 * Developer Mode. Lives on platform.db alongside `conversations`/`promotions`.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { id, timestamps } from '../db/conventions.js'

export const changeRequests = sqliteTable(
  'change_requests',
  {
    ...id(),
    /** Short public number shown to people ("#3"). */
    number: integer('number').notNull(),
    /** App the request is about; 'home' = a new app / platform-level request. */
    appId: text('app_id').notNull(),
    /** The user's request, in their words (plus detail the agent gathered). */
    request: text('request').notNull(),
    status: text('status', { enum: ['open', 'in_progress', 'done', 'rejected'] })
      .notNull()
      .default('open'),
    /** Draft working on it (set while in_progress / once done). */
    draftId: text('draft_id'),
    /** Device and conversation the request came from (soft references). */
    originDeviceId: text('origin_device_id'),
    conversationId: text('conversation_id'),
    ...timestamps(),
  },
  (t) => [index('change_requests_app_status_idx').on(t.appId, t.status)],
)

export type ChangeRequest = typeof changeRequests.$inferSelect
export type ChangeRequestStatus = ChangeRequest['status']
