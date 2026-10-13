import { defaultRangeExtractor } from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import {
  getActiveStickyHeaderIndex,
  getPreviousStickyHeaderIndex
} from '../sidebar/worktree-list/viewport/virtual-rows'

export const VAULT_GROUP_HEADER_ROW_HEIGHT = 32
export const VAULT_SESSION_ROW_HEIGHT = 98

export type VaultVirtualRow = { type: 'group' | 'session' }

export function getVaultStickyHeaderIndexes(rows: readonly VaultVirtualRow[]): number[] {
  const indexes: number[] = []
  rows.forEach((row, index) => {
    if (row.type === 'group') {
      indexes.push(index)
    }
  })
  return indexes
}

export function extractVaultVirtualRowIndexes(args: {
  range: Range
  stickyHeaderIndexes: readonly number[]
  /** Kept mounted while scrolled away, e.g. the row an aria-activedescendant names. */
  pinnedIndex?: number | null
}): number[] {
  const activeStickyHeaderIndex = getActiveStickyHeaderIndex(
    args.stickyHeaderIndexes,
    args.range.startIndex
  )
  const previousStickyHeaderIndex =
    activeStickyHeaderIndex === null
      ? null
      : getPreviousStickyHeaderIndex(args.stickyHeaderIndexes, activeStickyHeaderIndex)
  const extra = [activeStickyHeaderIndex, previousStickyHeaderIndex, args.pinnedIndex ?? null]
  const visible = defaultRangeExtractor(args.range)
  if (extra.every((index) => index === null)) {
    return visible
  }
  return Array.from(
    new Set([...extra.filter((index): index is number => index !== null), ...visible])
  ).sort((a, b) => a - b)
}
