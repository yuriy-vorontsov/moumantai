/**
 * Content addressing for releases: the set of promotable files of an app
 * directory and a SHA-256 over them. The same filter decides what goes into a
 * release artifact, so "what was validated" and "what was published" can be
 * compared byte for byte.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isEphemeralDraftPath } from '../drafts/draft-fs.js'

/** Never part of a release: server-owned draft state, VCS and installed deps. */
function isExcluded(relPosix: string): boolean {
  if (isEphemeralDraftPath(relPosix)) return true
  const top = relPosix.split('/')[0]
  return top === '.git' || top === 'node_modules' || relPosix.endsWith('/node_modules')
}

/** Sorted, POSIX-style relative paths of the files that make up the app. */
export function listReleaseFiles(dir: string): string[] {
  const root = fs.realpathSync(dir)
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name
      if (isExcluded(childRel)) continue
      const stat = fs.statSync(path.join(root, childRel))
      if (stat.isDirectory()) walk(childRel)
      else if (stat.isFile()) out.push(childRel)
    }
  }
  walk('')
  return out.sort()
}

/** SHA-256 hex over `path NUL bytes NUL` for every release file, in sorted order. */
export function contentHash(dir: string): string {
  const root = fs.realpathSync(dir)
  const h = crypto.createHash('sha256')
  for (const rel of listReleaseFiles(root)) {
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(root, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

/** Copy exactly the release files of `srcDir` into a new `destDir`. */
export function copyReleaseFiles(srcDir: string, destDir: string): void {
  const root = fs.realpathSync(srcDir)
  for (const rel of listReleaseFiles(root)) {
    const dest = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(root, rel), dest)
  }
}
