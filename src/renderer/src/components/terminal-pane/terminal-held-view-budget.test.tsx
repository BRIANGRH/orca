// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  reportHiddenTerminalViews,
  resetHiddenTerminalViewBudgetForTest,
  getHiddenTerminalViewCensus,
  releaseHiddenTerminalViewsForMemoryPressure
} from './terminal-hidden-view-budget'
import {
  readMountedTerminalTabViewBytes,
  registerMountedTerminalTabView
} from './mounted-terminal-view-census'
import { TERMINAL_TAB_HOT_RETAIN_MS } from './terminal-hidden-view-parking'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const MB = 1024 * 1024
const WORKTREE_ID = 'wt-1'
const storeState = vi.hoisted(() => ({
  settings: {},
  pendingStartupByTabId: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
  terminalLayoutsByTabId: {},
  runtimeStatusByEnvironmentId: new Map(),
  repos: [],
  sleepingAgentSessionsByPaneKey: {
    'tab-z:22222222-2222-4222-8222-222222222222': {
      paneKey: 'tab-z:22222222-2222-4222-8222-222222222222',
      tabId: 'tab-z',
      worktreeId: 'wt-1'
    }
  }
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  syncParkedTerminalTabWatchers: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

function terminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `${WORKTREE_ID}@@session-${id}`,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('held terminal view budget integration', () => {
  beforeEach(() => {
    resetHiddenTerminalViewBudgetForTest()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    resetHiddenTerminalViewBudgetForTest()
  })

  it('keeps clock-expired mounted sleeping memory charged across owners until unmount', () => {
    const args = {
      worktreeId: WORKTREE_ID,
      terminalTabs: [terminalTab('tab-a'), terminalTab('tab-z')],
      assignments: new Map<string, { groupId: string; isActiveInGroup: boolean }>(),
      isWorktreeActive: true,
      activeTerminalTabId: null,
      coldParkTerminalPanes: false,
      shouldMeasureHiddenWorktree: false,
      activityTerminalPortals: []
    }
    const { result, unmount } = renderHook(() => {
      useEffect(
        () =>
          registerMountedTerminalTabView('tab-z', {
            getRetainedBytes: () => 300 * MB,
            getHiddenState: () => ({ restorable: true })
          }),
        []
      )
      return useTerminalTabColdParking(args)
    })
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current.has('tab-z')).toBe(false)
    expect(readMountedTerminalTabViewBytes('tab-z')).toBe(300 * MB)

    const ordinary = [
      { tabId: 'ordinary', hiddenSinceMs: Date.now(), bytes: 200 * MB, parkable: true }
    ]
    expect(reportHiddenTerminalViews('another-workspace', ordinary)).toEqual(new Set(['ordinary']))
    act(() => {
      releaseHiddenTerminalViewsForMemoryPressure()
      vi.advanceTimersByTime(0)
    })
    expect(result.current.has('tab-z')).toBe(false)
    expect(getHiddenTerminalViewCensus()).toMatchObject({ keptViews: 1, keptKB: 300 * 1024 })
    vi.setSystemTime(Date.now() + 1)
    ordinary[0].hiddenSinceMs = Date.now()
    expect(reportHiddenTerminalViews('another-workspace', ordinary)).toEqual(new Set(['ordinary']))
    unmount()
    expect(readMountedTerminalTabViewBytes('tab-z')).toBeNull()
    expect(reportHiddenTerminalViews('another-workspace', ordinary)).toEqual(new Set())
    expect(getHiddenTerminalViewCensus()).toMatchObject({ keptViews: 0, keptKB: 0 })
  })
})
