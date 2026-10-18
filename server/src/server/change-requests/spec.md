# change-requests/ — User Mode → Developer Mode handoff

**Purpose:** Record capability requests users make in User Mode and hand them to the owner's Developer Mode without anyone copying a conversation (mutabl spec §8.1, AT-19).

## Public API

### `ChangeRequestStore` (`store.ts`)
- `new ChangeRequestStore(platformDb)`
- `create({ appId, request, originDeviceId?, conversationId? }) → { changeRequest, existing }`: numbers requests (`#1`, `#2`, …). An active request for the same app with the same text (case- and whitespace-insensitive) is returned instead of a duplicate.
- `listActive(appId?)`, `listAll()`, `getByNumber(n)`
- `linkToDraft(appId, draftId) → ChangeRequest[]`: moves the app's open requests to `in_progress` on that draft and returns everything the draft carries.
- `forDraft(draftId)`, `completeDraft(draftId)` (promote → `done`), `releaseDraft(draftId)` (discard → `open`, unlinked)
- `reject(number) → boolean`: owner closes an active request.

### Schema (`schema.ts`, platform.db migration `0015`)
`change_requests`: `id, number, app_id, request, status (open|in_progress|done|rejected), draft_id, origin_device_id, conversation_id, created_at, updated_at`.

## Wiring (in `main.ts`)
- `agent/synthesize-change-request-tool.ts` registers `request_app_change` on every app (User Agent tool).
- New requests → DEV-kind chat notice to **owner** sessions (stable id `change-request-<id>`; re-sent on `viewing`; the PWA drops duplicates by id).
- Dev turn → `linkToDraft` → requests go into the edit-agent system prompt as quoted data (`edit-session.ts`).
- Promote → `completeDraft`; Discard → `releaseDraft`. CLI: `change list`, `change reject`.

## Constraints
- Request text is untrusted user input. It is shown to the edit-agent as data, never as instructions, and grants no tool or permission.
- Recording a request never changes code; the published version stays live until the owner promotes a draft.

## Example
```ts
const { changeRequest } = store.create({ appId: 'todo', request: 'Add a calendar view' })
store.linkToDraft('todo', draftId)   // owner starts a dev turn
store.completeDraft(draftId)         // owner promotes → status 'done'
```
