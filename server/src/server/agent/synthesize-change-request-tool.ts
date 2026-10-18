/**
 * Synthesized `request_app_change` tool — the User Mode → Developer Mode
 * handoff (spec §8.1). Registered on every app (like `view_<faceId>`).
 *
 * The user agent calls it when the user asks for a capability the app does
 * not have. It only records a change request for the owner; it never edits
 * code, and the published version stays in use until the owner promotes a
 * draft built from it.
 */

import type { ChangeRequest } from '../change-requests/schema.js'
import type { ChangeRequestStore } from '../change-requests/store.js'
import type { ToolDefinition } from './types.js'

export const REQUEST_CHANGE_TOOL = 'request_app_change'

export interface SynthesizeChangeRequestToolDeps {
  appId: string
  store: ChangeRequestStore
  /** Fired for newly created (not deduplicated) requests — e.g. notify owners. */
  onCreated?: (changeRequest: ChangeRequest) => void
}

export function synthesizeChangeRequestTool(deps: SynthesizeChangeRequestToolDeps): ToolDefinition {
  return {
    name: REQUEST_CHANGE_TOOL,
    description:
      'Record a request for a NEW capability this app does not have yet (a new screen, field, ' +
      'filter, behavior or integration) so the owner can build it in Developer Mode. Use it ' +
      'instead of improvising or emulating the missing feature with other tools. It does not ' +
      'change the app now: tell the user the request was recorded and that the current version ' +
      'stays in use until the owner publishes an update.',
    parameters: {
      request: {
        type: 'string',
        required: true,
        description:
          "What the user wants the app to do, in the user's words plus any detail they gave",
      },
    },
    execute: async ({ params, conversationId, originDeviceId }) => {
      const text = typeof params.request === 'string' ? params.request.trim() : ''
      if (!text) return { result: null, error: 'request is required' }
      const { changeRequest, existing } = deps.store.create({
        appId: deps.appId,
        request: text,
        ...(originDeviceId ? { originDeviceId } : {}),
        ...(conversationId ? { conversationId } : {}),
      })
      if (!existing) deps.onCreated?.(changeRequest)
      return {
        result: {
          change_request: changeRequest.number,
          status: changeRequest.status,
          already_requested: existing,
          note: 'Recorded for the owner. The current version of the app stays in use until an update is published.',
        },
      }
    },
  }
}
