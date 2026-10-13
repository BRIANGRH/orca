import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type KeyboardEvent,
  type Ref
} from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getSessionRowId } from './ai-vault-session-row-display'
import type { AiVaultListRow } from './AiVaultVirtualRow'

export type AiVaultSessionListKeyboard = {
  /** Plain ↑/↓ move the selection and Enter opens it; a handled key is default-prevented. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export type AiVaultSessionSelection = {
  /** Row index of the selected session, or null when nothing is selectable. */
  selectedIndex: number | null
  select: (sessionId: string) => void
  /** Moves one session up or down, clamped at the ends; returns the new row index. */
  move: (delta: 1 | -1) => number | null
}

/** Stores only the chosen id; its row, or the first session once that is gone, is derived. */
export function useAiVaultSessionSelection(
  rows: readonly AiVaultListRow[],
  enabled: boolean
): AiVaultSessionSelection {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sessionIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.type === 'session' ? [index] : [])),
    [rows]
  )
  const chosenIndex = sessionIndexes.find((index) => sessionIdAt(rows, index) === selectedId)
  const selectedIndex = enabled ? (chosenIndex ?? sessionIndexes[0] ?? null) : null
  return {
    selectedIndex,
    select: setSelectedId,
    move: (delta) => {
      if (selectedIndex === null) {
        return null
      }
      const position = sessionIndexes.indexOf(selectedIndex) + delta
      const next = sessionIndexes[Math.min(Math.max(position, 0), sessionIndexes.length - 1)]
      setSelectedId(sessionIdAt(rows, next))
      return next
    }
  }
}

/** Exposes the selection to the search box that owns keyboard focus. */
export function useAiVaultSessionListKeyboard(
  ref: Ref<AiVaultSessionListKeyboard> | undefined,
  args: {
    rows: readonly AiVaultListRow[]
    selection: AiVaultSessionSelection
    scrollToIndex: (index: number) => void
    activate: (session: AiVaultSession, index: number) => void
    onActiveRowIdChange?: (rowId: string | null) => void
  }
): void {
  const { rows, selection, scrollToIndex, activate, onActiveRowIdChange } = args
  const { selectedIndex } = selection
  const selectedRow = selectedIndex === null ? undefined : rows[selectedIndex]
  const selectedSession = selectedRow?.type === 'session' ? selectedRow.session : null
  const activeRowId = selectedSession ? getSessionRowId(selectedSession.id) : null

  // Why: the search box sits in the header, outside this list, but names the active row.
  useEffect(() => {
    onActiveRowIdChange?.(activeRowId)
    return () => onActiveRowIdChange?.(null)
  }, [activeRowId, onActiveRowIdChange])

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const index = selection.move(event.key === 'ArrowDown' ? 1 : -1)
          if (index !== null) {
            event.preventDefault()
            scrollToIndex(index)
          }
          return
        }
        if (event.key === 'Enter' && selectedSession && selectedIndex !== null) {
          event.preventDefault()
          // A held Enter must not start the same session twice while the first open is underway.
          if (!event.repeat) {
            activate(selectedSession, selectedIndex)
          }
        }
      }
    }),
    [activate, scrollToIndex, selectedIndex, selectedSession, selection]
  )
}

function sessionIdAt(rows: readonly AiVaultListRow[], index: number): string | null {
  const row = rows[index]
  return row?.type === 'session' ? row.session.id : null
}
