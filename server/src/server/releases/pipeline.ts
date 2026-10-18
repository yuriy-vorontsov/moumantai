/**
 * Validation pipeline for a draft (mutabl spec §7.3). Runs every check,
 * records each step (ok, summary, bounded log, duration) and never throws for
 * expected failures. Used by the edit-agent's `request_promote_review` (so the
 * agent can fix problems) and by promote (publication is blocked unless a
 * passing run exists for the exact draft content).
 */

import fs from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type Database from 'better-sqlite3'
import type { AppDefinition, ToolSchema } from '../agent/types.js'
import { toToolSchema } from '../agent/types.js'
import { findEntryFile, reloadAppBundled, reloadDraftDef } from '../agent/app-loader.js'
import { validateFaceById, validateToolShape } from '../agent/edit-mcp-tools.js'
import { bootApp } from '../agent/boot-app.js'
import { runDraftTypecheck } from '../drafts/draft-typecheck.js'
import { cloneLiveDbToShadow } from '../drafts/draft-db.js'
import { contentHash, listReleaseFiles } from './hash.js'
import {
  checkDependencies,
  checkManifest,
  checkMigrations,
  diffTools,
  readMigrations,
  type MigrationPlan,
  type ToolDiff,
} from './policies.js'
import { runAppTests } from './test-runner.js'

const LOG_LIMIT = 4_000

export interface ValidationStep {
  name: string
  ok: boolean
  summary: string
  log?: string
  durationMs: number
}

export interface FileChange {
  path: string
  status: 'added' | 'removed' | 'modified'
  added: number
  removed: number
}

export interface PipelineResult {
  ok: boolean
  contentHash: string
  fromVersion: string | null
  toVersion: string | null
  steps: ValidationStep[]
  toolDiff: ToolDiff | null
  migrationPlan: MigrationPlan | null
  files: FileChange[]
}

export interface PipelineContext {
  draftId: string
  kind: 'edit' | 'new-app'
  draftDir: string
  shadowDbPath: string
  home: string
  repoRoot: string
  /** Active release source (realpath of apps-src/<id>); null for a new app. */
  activeDir: string | null
  /** Live app DB (edit drafts). */
  liveDbPath: string | null
  /** Paths the sandboxed tests must not read (Moumantai home, credentials). */
  denyRead: string[]
  engineVersion: string
}

type StepOutcome = { ok: boolean; summary: string; log?: string }

async function timed(
  name: string,
  fn: () => Promise<StepOutcome> | StepOutcome,
): Promise<ValidationStep> {
  const t0 = Date.now()
  try {
    const r = await fn()
    return {
      name,
      ...r,
      ...(r.log ? { log: r.log.slice(-LOG_LIMIT) } : {}),
      durationMs: Date.now() - t0,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      name,
      ok: false,
      summary: message.split('\n')[0]!.slice(0, 300),
      log: message.slice(-LOG_LIMIT),
      durationMs: Date.now() - t0,
    }
  }
}

const problemsOutcome = (problems: string[], okSummary: string): StepOutcome =>
  problems.length === 0
    ? { ok: true, summary: okSummary }
    : { ok: false, summary: problems[0]!, log: problems.join('\n') }

function lineCount(file: string): number {
  return fs.readFileSync(file, 'utf8').split('\n').length
}

/** Per-file change list vs the active release (line counts are approximate for edits). */
export function fileChanges(draftDir: string, activeDir: string | null): FileChange[] {
  const draftFiles = new Set(listReleaseFiles(draftDir))
  const activeFiles = new Set(activeDir ? listReleaseFiles(activeDir) : [])
  const out: FileChange[] = []
  for (const rel of [...new Set([...draftFiles, ...activeFiles])].sort()) {
    const inDraft = draftFiles.has(rel)
    const inActive = activeFiles.has(rel)
    if (inDraft && !inActive) {
      out.push({
        path: rel,
        status: 'added',
        added: lineCount(path.join(draftDir, rel)),
        removed: 0,
      })
    } else if (!inDraft && inActive) {
      out.push({
        path: rel,
        status: 'removed',
        added: 0,
        removed: lineCount(path.join(activeDir!, rel)),
      })
    } else {
      const a = fs.readFileSync(path.join(activeDir!, rel), 'utf8').split('\n')
      const b = fs.readFileSync(path.join(draftDir, rel), 'utf8').split('\n')
      if (a.join('\n') === b.join('\n')) continue
      const before = new Map<string, number>()
      for (const l of a) before.set(l, (before.get(l) ?? 0) + 1)
      let added = 0
      for (const l of b) {
        const n = before.get(l) ?? 0
        if (n > 0) before.set(l, n - 1)
        else added++
      }
      const removed = [...before.values()].reduce((s, n) => s + n, 0)
      out.push({ path: rel, status: 'modified', added, removed })
    }
  }
  return out
}

function closeDb(db: unknown): void {
  try {
    ;(db as { $client: Database.Database }).$client.close()
  } catch {
    /* best-effort */
  }
}

export async function runValidationPipeline(ctx: PipelineContext): Promise<PipelineResult> {
  const hash = contentHash(ctx.draftDir)
  const steps: ValidationStep[] = []
  let draftDef: AppDefinition | null = null
  let activeDef: AppDefinition | null = null
  let toolDiff: ToolDiff | null = null
  let migrationPlan: MigrationPlan | null = null
  // Under <home>/tmp, never the OS tmpdir: bundles imported from here would
  // otherwise join a dev watcher's graph (`tsx watch`) and restart the server
  // when the dir is removed. (Only the sandboxed test run uses the OS tmpdir.)
  fs.mkdirSync(path.join(ctx.home, 'tmp'), { recursive: true })
  const scratch = fs.mkdtempSync(path.join(ctx.home, 'tmp', 'validate-'))

  try {
    // 1. Load both definitions (bundled, so edits to non-entry files count).
    steps.push(
      await timed('load', async () => {
        draftDef = await reloadDraftDef(ctx.draftDir)
        if (ctx.activeDir) {
          const entry = findEntryFile(ctx.activeDir)
          if (!entry) throw new Error(`active release has no index.ts (${ctx.activeDir})`)
          activeDef = await reloadAppBundled(entry, scratch)
        }
        return {
          ok: true,
          summary: `${draftDef.faces.length} faces, ${draftDef.tools.length} tools`,
        }
      }),
    )
    const draft = draftDef as AppDefinition | null
    const active = activeDef as AppDefinition | null

    // 2. Manifest: id, version bump, engine compatibility.
    steps.push(
      await timed('manifest', () => {
        if (!draft) return { ok: false, summary: 'draft did not load' }
        const problems = checkManifest({
          draft: draft.manifest,
          active: active?.manifest ?? null,
          engineVersion: ctx.engineVersion,
        })
        const from = active ? `${active.manifest.version} → ` : ''
        return problemsOutcome(problems, `${draft.manifest.id} ${from}${draft.manifest.version}`)
      }),
    )

    // 3. Dependencies: no new packages or disallowed imports.
    steps.push(
      await timed('dependencies', () =>
        problemsOutcome(checkDependencies(ctx.draftDir, ctx.activeDir), 'no new dependencies'),
      ),
    )

    // 4. Faces resolve against the shadow DB; tools have a valid shape.
    steps.push(
      await timed('faces and tools', async () => {
        if (!draft) return { ok: false, summary: 'draft did not load' }
        const errors: string[] = []
        for (const face of draft.faces) {
          const r = await validateFaceById(ctx.draftDir, ctx.shadowDbPath, face.id)
          if (!r.ok) errors.push(...r.errors.map((e) => `${e.target}: ${e.message}`))
        }
        for (const tool of draft.tools) {
          const r = validateToolShape(tool.name, tool)
          if (!r.ok) errors.push(...r.errors.map((e) => `${e.target}: ${e.message}`))
        }
        return problemsOutcome(
          errors,
          `${draft.faces.length} faces resolved, ${draft.tools.length} tools valid`,
        )
      }),
    )

    // 5. Static types (diff-scoped tsc).
    steps.push(
      await timed('types', () => {
        const tc = runDraftTypecheck({
          draftId: ctx.draftId,
          draftDir: ctx.draftDir,
          liveSrcDir: ctx.activeDir,
          home: ctx.home,
          repoRoot: ctx.repoRoot,
        })
        if (tc.skipped) return { ok: true, summary: `skipped: ${tc.skipped}` }
        return problemsOutcome(
          tc.errors.map((e) => `${e.target}${e.line ? `:${e.line}` : ''} ${e.message}`),
          'tsc: no errors in changed files',
        )
      }),
    )

    // 6. Migrations: released ones unchanged, new ones additive, dry run on a clone of live data.
    const clone = path.join(scratch, 'live-clone.sqlite')
    let cloneMigrated = false
    steps.push(
      await timed('migrations', () => {
        if (!draft) return { ok: false, summary: 'draft did not load' }
        const draftMigrations = readMigrations(draft.migrationsFolder)
        const activeMigrations = readMigrations(active?.migrationsFolder)
        const { problems, plan } = checkMigrations(draftMigrations, activeMigrations)
        migrationPlan = plan
        if (problems.length > 0) {
          return {
            ok: false,
            summary: `irreversible migration: ${problems[0]}`,
            log: problems.join('\n'),
          }
        }
        if (draft.migrationsFolder && ctx.liveDbPath && fs.existsSync(ctx.liveDbPath)) {
          cloneLiveDbToShadow(ctx.liveDbPath, clone)
          const db = drizzle({ connection: clone, casing: 'snake_case' })
          try {
            migrate(db, { migrationsFolder: draft.migrationsFolder })
          } finally {
            closeDb(db)
          }
          cloneMigrated = true
        }
        return {
          ok: true,
          summary:
            plan.added.length === 0
              ? 'no new migrations'
              : `${plan.added.join(', ')} additive; dry run on live data ok`,
        }
      }),
    )

    // 7. The ACTIVE release still works on the migrated schema → restore stays possible.
    if (active && ctx.liveDbPath) {
      steps.push(
        await timed('previous release on new schema', () => {
          if (!cloneMigrated) {
            if (fs.existsSync(ctx.liveDbPath!)) cloneLiveDbToShadow(ctx.liveDbPath!, clone)
            else return { ok: true, summary: 'no live data yet' }
          }
          const booted = bootApp({
            appDef: active,
            dbPath: clone,
            home: ctx.home,
            appId: active.manifest.id,
          })
          try {
            const errors: string[] = []
            for (const face of booted.faceRegistry.list()) {
              try {
                face.resolve({ db: booted.db, params: {} })
              } catch (err) {
                errors.push(`${face.id}: ${err instanceof Error ? err.message : String(err)}`)
              }
            }
            return problemsOutcome(
              errors,
              `${active.manifest.version} resolves all ${booted.faceRegistry.list().length} faces`,
            )
          } finally {
            closeDb(booted.db)
          }
        }),
      )
    }

    // 8. The app's own tests, sandboxed.
    steps.push(
      await timed('tests', async () => {
        const appId = draft?.manifest.id ?? 'app'
        const r = await runAppTests({
          appDir: ctx.draftDir,
          appId,
          repoRoot: ctx.repoRoot,
          denyRead: ctx.denyRead,
        })
        const where = r.ran ? (r.sandboxed ? ' (sandboxed)' : '') : ''
        return { ok: r.ok, summary: `${r.summary}${where}`, ...(r.ok ? {} : { log: r.log }) }
      }),
    )

    // 9. Tool surface (permissions) diff + reserved names.
    steps.push(
      await timed('tool permissions', () => {
        if (!draft) return { ok: false, summary: 'draft did not load' }
        const schemas = (def: AppDefinition | null): ToolSchema[] =>
          def ? def.tools.map(toToolSchema) : []
        const { diff, problems } = diffTools(schemas(draft), schemas(active))
        toolDiff = diff
        const parts = [
          diff.added.length ? `+${diff.added.join(', +')}` : '',
          diff.removed.length ? `-${diff.removed.join(', -')}` : '',
          diff.changed.length ? `~${diff.changed.join(', ~')}` : '',
        ].filter(Boolean)
        return problemsOutcome(problems, parts.length ? parts.join(' ') : 'no tool changes')
      }),
    )
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  const draft = draftDef as AppDefinition | null
  const active = activeDef as AppDefinition | null
  return {
    ok: steps.every((s) => s.ok),
    contentHash: hash,
    fromVersion: active?.manifest.version ?? null,
    toVersion: draft?.manifest.version ?? null,
    steps,
    toolDiff,
    migrationPlan,
    files: fileChanges(ctx.draftDir, ctx.activeDir),
  }
}

/** Plain-text report for the Dev thread / CLI. */
export function formatReport(r: PipelineResult): string {
  const lines: string[] = []
  const versions = r.fromVersion ? `${r.fromVersion} → ${r.toVersion}` : `new app ${r.toVersion}`
  lines.push(`${r.ok ? 'Ready to publish' : 'Publication blocked'} — ${versions}`)
  const added = r.files.reduce((s, f) => s + f.added, 0)
  const removed = r.files.reduce((s, f) => s + f.removed, 0)
  lines.push(`Files: ${r.files.length} changed (+${added}/−${removed})`)
  for (const f of r.files.slice(0, 12)) {
    lines.push(
      `  ${f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M'} ${f.path} (+${f.added}/−${f.removed})`,
    )
  }
  if (r.files.length > 12)
    lines.push(`  … ${r.files.length - 12} more (task server:cli -- draft diff)`)
  lines.push('Checks:')
  for (const s of r.steps) lines.push(`  ${s.ok ? '✓' : '✗'} ${s.name}: ${s.summary}`)
  return lines.join('\n')
}
