/**
 * Minimal semver for release policy: `MAJOR.MINOR.PATCH` versions and ranges
 * made of space-separated comparators (`^1.2.0`, `~0.1.0`, `>=0.1.0 <1.0.0`,
 * `0.1.0`, `*`). Pre-release/build tags are not supported (rejected).
 */

export type Version = readonly [number, number, number]

export function parseVersion(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

function comparatorHolds(version: Version, comparator: string): boolean | null {
  if (comparator === '*' || comparator === 'x') return true
  const m = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator)
  if (!m) return null
  const op = m[1] ?? '='
  const target = parseVersion(m[2]!)!
  const c = compareVersions(version, target)
  switch (op) {
    case '=':
      return c === 0
    case '>':
      return c > 0
    case '>=':
      return c >= 0
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    case '~':
      return c >= 0 && version[0] === target[0] && version[1] === target[1]
    case '^': {
      if (c < 0) return false
      if (target[0] > 0) return version[0] === target[0]
      if (target[1] > 0) return version[0] === 0 && version[1] === target[1]
      return version[0] === 0 && version[1] === 0 && version[2] === target[2]
    }
  }
  return null
}

/** True/false when `range` is valid; null when it cannot be parsed. */
export function satisfies(version: string, range: string): boolean | null {
  const v = parseVersion(version)
  if (!v) return null
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0) return null
  let ok = true
  for (const c of comparators) {
    const holds = comparatorHolds(v, c)
    if (holds === null) return null
    ok = ok && holds
  }
  return ok
}
