# jobs/ — durable agent jobs, approvals, event log

**Purpose:** Every agent run is a durable job the platform owns, independent of SDK sessions (mutabl spec §9): its state, its tool calls, the user's approvals for risky actions, cancellation, retries and restart recovery. Clients see jobs through the home **Agent Jobs** face.

## Model
- **Job** (`jobs`): `user_turn` (chat), `dev_turn` (Developer Mode), `escalation` (a form tap the agent completes). Principal = device id; `requestId` = correlation id (client message id or user row id); `rootRequestId` = the first attempt's request id (inherited by retries); SDK session id; progress line; error code/message; result row.
- **State machine** (spec §9.1, enforced by `JobStore.transition`): `QUEUED → RUNNING → (WAITING_FOR_APPROVAL → RUNNING) → SUCCEEDED | FAILED | CANCELED`; `QUEUED/RUNNING → INTERRUPTED → RECOVERY_REQUIRED | QUEUED`. Terminal states have no exits; a retry is a new job with `retryOf`.
- **Events** (`job_events`): `seq` is one monotonic sequence across all jobs; payloads are bounded JSON (2 KB) and never carry secrets or raw tool output. `eventsAfter(seq)` is the replay primitive. Types: `state`, `tool.started`, `tool.finished`, `tool.denied`, `approval.requested`, `approval.decided`, `cancel.requested`, `retry.requested`, `progress`, `recovery`.
- **Tool invocations** (`tool_invocations`): every agent tool call with risk, input hash, outcome (`started | ok | error | denied | approval_required | deduplicated`) and bounded result.
- **Approval requests** (`approval_requests`): a risky agent call held for the user (`pending → approved | rejected`, then `executed | failed`). Decisions are also written to the Phase 3 `approvals` table (`target = tool:<id>`).

## Tool risk and the gate
- `defineTool({ risk })`: `read | write (default) | destructive | external`; `approvalSummary(params, db)` gives the human sentence. Synthesized `view_*` tools are reads.
- `AgentLoop` calls the job's `ToolGate` around every **agent** tool call (both backends, delegated sub-turns included):
  - destructive / external → not executed; an approval request is stored, the model gets `{status: "approval_required"}`, a system note is posted in the chat, the job ends the turn in `WAITING_FOR_APPROVAL`. The tool's description sent to the model says so up front.
  - write → idempotency key `sha256(rootRequestId | app:tool:inputHash | n-th occurrence)`; a successful invocation with that key from an *earlier attempt* is returned instead of running again (`already_done`). Reads are never deduplicated.
- UI taps are the user's explicit action and are not gated.

## JobService (`service.ts`)
- `create` / `begin` (QUEUED→RUNNING, returns the job's own AbortSignal, or null if it was canceled in the queue) / `finish` (settles from the outcome, cancel request and pending approvals).
- `respondApproval(id, approve|reject, device)`: job principal or an owner. Approve executes the stored call verbatim, once (`approval:<id>` key, no LLM), posts "Done: …" and settles the job; reject posts "Not done — you rejected …" and cancels the job when nothing else ran.
- `cancel(job, device)`: queued → canceled without running; waiting → canceled, approvals rejected; running → that job's AbortController (not the whole conversation queue). Completed effects are not undone (spec §9.3).
- `retry(job, device)`: FAILED / CANCELED / RECOVERY_REQUIRED chat jobs re-run the original text as a new job with the same root request id.
- `recoverOnStartup()`: QUEUED/RUNNING → INTERRUPTED → RECOVERY_REQUIRED with what completed and what may or may not have; approved-but-unsettled approvals → failed. WAITING_FOR_APPROVAL survives.

## UI and delivery
- Home face **Agent Jobs** (`apps/home/faces/jobs.ts`, view model `view.ts`): approvals (Approve / Reject), running (progress, Cancel), recent (state, duration, error, Retry), event log (`#seq · time · app · event`).
- UI-only tools `respond_approval`, `cancel_job`, `retry_job` (`ui-tools.ts`) are synthesized on every app, since the sheet opens over any app; they also bypass draft-preview routing.
- `main.ts` pushes the Jobs face to every phone session on job changes (coalesced, 100 ms) and with the home faces on every (re)connect. Chat rows are snapshotted by `chatWindow` and deduplicated by id. Clients do not send an event cursor: reconnect delivers the authoritative snapshot (transport contract) — a cursor would need a protocol field (Kotlin regeneration).

## Related changes outside this module
- UI taps run on TurnQueue key `ui:<conversation>` (never behind an agent turn); escalations still take the conversation slot (`action-handler.ts`).
- Failed-turn replay: the Claude adapter reports the last assistant message uuid of a successful turn (`done.resumeAt`); `conversations.sdk_resume_at` stores it and the next turn resumes with `resumeSessionAt`. A failure with no good point unbinds the session (`bound-turn.ts`).

## Constraints
- No exactly-once claim: an approved action interrupted by a crash is marked failed / recovery required, never silently re-run.
- Payloads are bounded; tool output is stored only as a bounded summary.
- Platform migration `0017_jobs`.
