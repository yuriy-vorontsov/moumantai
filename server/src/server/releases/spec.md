# releases/ — immutable releases, validation, publish and restore

**Purpose:** Turn an approved draft into an immutable, content-addressed release, switch the active version atomically, and restore an earlier compatible release later (mutabl spec §7.3–7.6). Drafts (`drafts/`) are where changes are made; releases are what runs.

## Model
- **Release** = a copied app source tree under `<home>/releases/<appId>/<version>-<id8>/`, identified by a SHA-256 **content hash** over the sorted relative paths + bytes of its release files (draft ephemerals, `.git`, `node_modules` excluded). Never modified after creation; re-verified (`verifyArtifact`) before any reuse.
- **Active pointer** = `<home>/apps-src/<appId>`, a symlink to the active release's artifact. Switched atomically (symlink to a temp name, then `rename` over the old link). A pre-release real directory (git/local install) is moved aside to `releases/<appId>/.source-before-releases-<ts>`; a pre-release symlink (dev install pointing into the repo) is simply replaced — the repo is never written.
- **Baseline** = on an app's first publish, the source that was running is captured as a `source='baseline'` release, so the pre-mutabl version is always restorable.
- **Data is never rolled back.** Migrations are forward-only and must be additive (policy below); the live DB is backed up (`VACUUM INTO <home>/backups/<appId>/<ts>-before-<label>.sqlite`) before every migration and every restore.

## Tables (platform.db, migration `0016_releases`)
- `releases` — id, app_id, version, content_hash, schema_tag, status `active|superseded` (exactly one active per app), source `baseline|draft`, draft_id, approval_id, validation_run_id, artifact_dir, migration_plan (JSON `{added, additive}`), db_backup, created_at, activated_at.
- `validation_runs` — one pipeline run per (draft, content hash): ok + the full `PipelineResult` JSON.
- `approvals` — principal (device id or `cli`), target (`draft:<id>`), content hash the owner approved, decision `approved|rejected`.
- `lifecycle_events` — append-only state trail for drafts (`DRAFTING → REVIEW_PENDING → APPROVED → VALIDATING → PUBLISHING → PUBLISHED | VALIDATION_FAILED | FAILED | DISCARDED`) and releases (`ACTIVATED`, `RESTORED`), with actor + detail.

## Public API
- `ReleaseStore` (`store.ts`): `active(appId)`, `list(appId?)` (newest first), `get(id)`, `byVersion(appId, version)`, `insert(release)` (inserted superseded), `markActive(appId, id)` (transaction), `recordRun`, `passingRun(draftId, hash)`, `getRun(id)`, `approve(...)`, `event(...)`, `events(subjectType, id)`.
- `runValidationPipeline(ctx)` (`pipeline.ts`) → `PipelineResult { ok, contentHash, fromVersion, toVersion, steps[], toolDiff, migrationPlan, files[] }`; `formatReport(result)` (the owner's review card); `fileChanges(draftDir, activeDir)`.
- `publish.ts`: `createArtifact`, `verifyArtifact`, `switchPointer`, `removePointer`, `backupDatabase`, `ensureBaseline`, `restoreIncompatibility`, `pointerPath`, `releasesDir`, `backupsDir`.
- `restoreRelease(deps, appId, versionOrId)` (`restore.ts`) → `{ ok, release, activated } | { ok: false, error }`.
- `buildReleasesView(deps)` (`view.ts`) → the home app's Release History face model.
- `runAppTests(opts)` (`test-runner.ts`) — the sandboxed `tests` step.

## Validation pipeline (spec §7.3), in order
1. **load** — bundle-load the draft definition.
2. **manifest** — id unchanged; version is SemVer and **greater than the active release**; `moumantaiMinVersion` ≤ this server (`incompatible: the app requires Moumantai >= X; this server is Y`).
3. **dependencies** — runtime imports limited to relative paths, `moumantai(/ui)`, `drizzle-orm*` and what the active release already imports; no package manifests or lockfiles in the draft.
4. **faces and tools** — the same validators the edit agent uses (`validateFaceById`, `validateToolShape`).
5. **types** — `tsc` over the draft (`runDraftTypecheck`).
6. **migrations** — every new migration must be additive (CREATE TABLE/INDEX, INSERT, UPDATE, ADD COLUMN nullable or with DEFAULT); applied to a fresh clone of live data.
7. **previous release on new schema** — the active release boots on the migrated clone (so restore stays possible).
8. **tests** — the app's `tests/*.test.ts` run under vitest in a copy of the draft, inside `sandbox-exec` on macOS: no outbound network, writes only to the work/tmp dirs, reads of the Moumantai home and credential dirs denied, scrubbed env, timeout + process-group kill. Elsewhere it runs unsandboxed and reports `sandboxed: false`.
9. **tool permissions** — tool diff vs the active release; reserved names (`view_*`, `mcp__*`, `request_app_change`) rejected.

A passing run is stored against the draft's content hash; promote reuses it only for exactly that content.

## Publish (edit draft) — `drafts/draft-promote.ts`
APPROVE (bound to the content hash) → VALIDATE (reuse or run; failure blocks with the report) → BASELINE (first publish) → ARTIFACT (hash must equal the validated hash) → PRE-FLIGHT migrate a throwaway live clone → BACKUP + MIGRATE live → insert release → SWITCH pointer → ACTIVATE (on failure: point back at the previous release and re-activate) → markActive + events + promotions row → remove the worktree. New-app drafts skip the DB steps and check `manifest.id` collisions.

## Restore
`verifyArtifact` → `restoreIncompatibility` (every migration the target ships is applied, and every migration applied since came from an additive release plan) → backup → switch pointer → activate (rollback on failure) → markActive → `RESTORED` event.
- **Home → Releases face** (`apps/home/faces/releases.ts`): every app's releases with status, checks and a Restore button on restorable rows. The button calls the UI-only `restore_release` tool (`ToolDefinition.uiOnly`: never offered to or callable by any agent), owner-gated in `main.ts`, which then re-broadcasts the app's faces to every device.
- **CLI** `release restore <app> <version|id>` switches the pointer only; a running server picks it up on restart.

## Constraints
- The release workflow requires the app to be installed in `<home>/apps-src/<appId>` (promote fails with a clear message otherwise).
- Releases and approvals are never deleted by the server.
- The draft preview still executes draft code in the server process (only the tests step is sandboxed) — see mutabl `docs/threat-model.md`.
- `sandbox-exec` is macOS-only; Linux deployments need an equivalent (bubblewrap/nsjail) before untrusted drafts are validated there.
