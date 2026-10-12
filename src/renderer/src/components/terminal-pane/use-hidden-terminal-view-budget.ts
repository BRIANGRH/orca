import { useCallback, useEffect, useId, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  buildHiddenTerminalViews,
  reportHiddenTerminalViews,
  subscribeHiddenTerminalViewBudget,
  type HiddenViewBudgetInput
} from './terminal-hidden-view-budget'

/**
 * Binds one worktree's cold-park pass to the renderer-wide hidden-view budget.
 * Bumps the pass's revision when another worktree's report changes which of
 * this worktree's tabs still fit, and withdraws its views on unmount.
 */
export function useHiddenTerminalViewBudget(
  setParkingRevision: Dispatch<SetStateAction<number>>
): (input: HiddenViewBudgetInput | null) => ReadonlySet<string> {
  const ownerId = useId()
  const lastKnownBytesRef = useRef(new Map<string, number>())
  useEffect(() => {
    const unsubscribe = subscribeHiddenTerminalViewBudget(ownerId, () =>
      setParkingRevision((revision) => revision + 1)
    )
    return () => {
      unsubscribe()
      reportHiddenTerminalViews(ownerId, [])
    }
  }, [ownerId, setParkingRevision])
  return useCallback(
    (input: HiddenViewBudgetInput | null) =>
      reportHiddenTerminalViews(
        ownerId,
        input ? buildHiddenTerminalViews(input, lastKnownBytesRef.current) : []
      ),
    [ownerId]
  )
}
