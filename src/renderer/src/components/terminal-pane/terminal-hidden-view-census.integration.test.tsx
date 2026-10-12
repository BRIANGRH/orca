// @vitest-environment happy-dom
import { useEffect, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const mocks = vi.hoisted(() => {
  const sleepingAgentSessionsByPaneKey: Record<
    string,
    { paneKey: string; tabId: string; worktreeId: string }
  > = {}
  return {
    coverage: true,
    exemptTabIds: new Set<string>(),
    state: {
      settings: {},
      runtimeStatusByEnvironmentId: new Map(),
      pendingStartupByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      sleepingAgentSessionsByPaneKey
    }
  }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => mocks.coverage,
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  syncParkedTerminalTabWatchers: vi.fn()
}))
vi.mock('./terminal-eviction-exempt-tabs', () => ({
  selectEvictionExemptTerminalTabIds: () => mocks.exemptTabIds,
  selectEvictionExemptTerminalTabLayoutKey: () => ''
}))
vi.mock('./parked-terminal-tab-capture-episodes', () => ({
  captureNewlyParkedTerminalTabs: vi.fn()
}))
vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({})
}))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import { registerMountedTerminalTabView } from './mounted-terminal-view-census'
import {
  getHiddenTerminalViewCensus,
  releaseHiddenTerminalViewsForMemoryPressure,
  resetHiddenTerminalViewBudgetForTest
} from './terminal-hidden-view-budget'

const WORKSPACE = 'folder-workspace'
const MB = 1024 * 1024

function tab(id: string, restorable = true): TerminalTab {
  return {
    id,
    ptyId: restorable ? `${WORKSPACE}@@${id}` : id,
    worktreeId: WORKSPACE,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

// Stand in for the existing pane mount/disposer; the real parking hook owns the render verdict.
function MountedView({ terminalTab }: { terminalTab: TerminalTab }): null {
  const tabRef = useRef(terminalTab)
  tabRef.current = terminalTab
  useEffect(
    () =>
      registerMountedTerminalTabView(terminalTab.id, {
        getRetainedBytes: () => 10 * MB,
        getHiddenState: () => ({ restorable: tabRef.current.ptyId?.includes('@@') === true })
      }),
    [terminalTab.id]
  )
  return null
}

type ParkingArgs = Parameters<typeof useTerminalTabColdParking>[0]

function Surface({ args }: { args: ParkingArgs }): React.JSX.Element {
  const parked = useTerminalTabColdParking(args)
  return (
    <>
      {args.terminalTabs.map((terminalTab) =>
        parked.has(terminalTab.id) ? null : (
          <MountedView key={terminalTab.id} terminalTab={terminalTab} />
        )
      )}
    </>
  )
}

function args(terminalTabs: TerminalTab[]): ParkingArgs {
  return {
    worktreeId: WORKSPACE,
    terminalTabs,
    assignments: new Map(),
    isWorktreeActive: true,
    activeTerminalTabId: null,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: []
  }
}

beforeEach(() => {
  resetHiddenTerminalViewBudgetForTest()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  cleanup()
  resetHiddenTerminalViewBudgetForTest()
  mocks.state.sleepingAgentSessionsByPaneKey = {}
  mocks.exemptTabIds = new Set()
  mocks.coverage = true
  vi.useRealTimers()
})

describe('hidden census through the final parking render', () => {
  it('includes a sleeping-owned clock-selected view, then drops it on actual unmount', () => {
    mocks.state.sleepingAgentSessionsByPaneKey = {
      held: { paneKey: 'held', tabId: 'held', worktreeId: WORKSPACE }
    }
    const first = args([tab('held')])
    const surface = render(<Surface args={first} />)
    act(() => vi.advanceTimersByTime(40_000))
    const second = args([tab('held'), tab('newest')])
    surface.rerender(<Surface args={second} />)
    act(() => vi.advanceTimersByTime(5 * 60_000))
    expect(getHiddenTerminalViewCensus()).toMatchObject({ keptViews: 2, keptKB: 20 * 1024 })

    mocks.state.sleepingAgentSessionsByPaneKey = {}
    surface.rerender(<Surface args={{ ...second, terminalTabs: [...second.terminalTabs] }} />)
    expect(getHiddenTerminalViewCensus()).toMatchObject({ keptViews: 1, keptKB: 10 * 1024 })
    surface.unmount()
    expect(getHiddenTerminalViewCensus().keptViews).toBe(0)
  })

  it('includes a force-park-exempt mounted view when the hook withdraws its policy report', () => {
    mocks.exemptTabIds = new Set(['legacy'])
    render(
      <Surface
        args={{ ...args([tab('legacy', false)]), coldParkTerminalPanes: true, isForceParked: true }}
      />
    )
    expect(getHiddenTerminalViewCensus()).toMatchObject({
      unrestorableViews: 1,
      unrestorableKB: 10 * 1024
    })
  })

  it('counts pressure-withheld occupancy and removes it only when watcher coverage allows parking', () => {
    mocks.coverage = false
    const current = args([tab('hidden')])
    const surface = render(<Surface args={current} />)
    act(() => vi.advanceTimersByTime(31_000))
    act(() => {
      releaseHiddenTerminalViewsForMemoryPressure()
      vi.advanceTimersByTime(0)
    })
    expect(getHiddenTerminalViewCensus()).toMatchObject({ overBudgetViews: 1 })
    mocks.coverage = true
    surface.rerender(<Surface args={{ ...current, terminalTabs: [...current.terminalTabs] }} />)
    expect(getHiddenTerminalViewCensus()).toMatchObject({ overBudgetViews: 0, keptViews: 0 })
  })
})
