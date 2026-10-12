// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetHiddenTerminalViewBudgetForTest,
  TERMINAL_HIDDEN_VIEW_BUDGET_BYTES,
  type HiddenViewBudgetInput
} from './terminal-hidden-view-budget'
import { registerMountedTerminalTabView } from './mounted-terminal-view-census'
import { useHiddenTerminalViewBudget } from './use-hidden-terminal-view-budget'

function input(worktreeId: string, tabId: string, hiddenSinceMs: number): HiddenViewBudgetInput {
  return {
    worktreeId,
    terminalTabs: [
      {
        id: tabId,
        ptyId: `${worktreeId}@@${tabId}`,
        isVisible: false,
        hasActivityTerminalPortal: false,
        hiddenSinceMs
      }
    ],
    parkableTabIds: new Set([tabId]),
    clockParkedTabIds: new Set()
  }
}

describe('useHiddenTerminalViewBudget', () => {
  beforeEach(() => {
    resetHiddenTerminalViewBudgetForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetHiddenTerminalViewBudgetForTest()
  })

  it('wakes the older worktree when a newer one fills the budget, and frees it on unmount', () => {
    const big = TERMINAL_HIDDEN_VIEW_BUDGET_BYTES * 0.6
    registerMountedTerminalTabView('tab-a', {
      getRetainedBytes: () => big,
      getHiddenState: () => ({ restorable: true })
    })
    registerMountedTerminalTabView('tab-b', {
      getRetainedBytes: () => big,
      getHiddenState: () => ({ restorable: true })
    })
    const setRevisionA = vi.fn()
    const a = renderHook(() => useHiddenTerminalViewBudget(setRevisionA))
    const b = renderHook(() => useHiddenTerminalViewBudget(vi.fn()))

    expect(a.result.current(input('wt-a', 'tab-a', 1))).toEqual(new Set())
    expect(b.result.current(input('wt-b', 'tab-b', 2))).toEqual(new Set())
    act(() => {
      vi.runAllTimers()
    })
    expect(setRevisionA).toHaveBeenCalledTimes(1)
    expect(a.result.current(input('wt-a', 'tab-a', 1))).toEqual(new Set(['tab-a']))

    b.unmount()
    act(() => {
      vi.runAllTimers()
    })
    expect(setRevisionA).toHaveBeenCalledTimes(2)
    expect(a.result.current(input('wt-a', 'tab-a', 1))).toEqual(new Set())
  })
})
