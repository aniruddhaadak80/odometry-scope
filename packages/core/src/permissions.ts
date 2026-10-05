import type { Permission } from './types.js'

/** Ordered least- to most-privileged. Index is the escalation rank. */
export const PERMISSION_RANK: readonly Permission[] = [
  'fs:read',
  'net:fetch',
  'env:read',
  'fs:write',
  'proc:spawn',
  'secrets:read',
] as const

export function rank(permission: Permission): number {
  const index = PERMISSION_RANK.indexOf(permission)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/**
 * The product runs sandboxed by default. A tool may only use permissions the caller
 * granted; anything beyond that is refused before the handler runs, not caught after.
 */
export function isSatisfied(required: readonly Permission[], granted: readonly Permission[]): boolean {
  const ceiling = granted.length === 0 ? 0 : Math.max(...granted.map(rank))
  return required.every((p) => rank(p) <= ceiling)
}

export function describePermissions(permissions: readonly Permission[]): string {
  return permissions.length === 0 ? 'none' : [...permissions].sort((a, b) => rank(a) - rank(b)).join(', ')
}
