import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildHiddenTerminalViews,
  registerMountedTerminalTabView,
  reportHiddenTerminalViews,
  resetHiddenTerminalViewBudgetForTest,
  selectHiddenTerminalViewsOverBudget,
  subscribeHiddenTerminalViewBudget,
  type HiddenTerminalView
} from './terminal-hidden-view-budget'
import { selectColdParkedTerminalTabs } from './terminal-hidden-view-parking'

const MB = 1024 * 1024

function view(tabId: string, hiddenSinceMs: number, bytes: number, parkable = true) {
  return { tabId, hiddenSinceMs, bytes, parkable } satisfies HiddenTerminalView
}

describe('selectHiddenTerminalViewsOverBudget', () => {
  it('keeps the most recently hidden views that fit and parks the older rest', () => {
    const over = selectHiddenTerminalViewsOverBudget(
      [view('old', 1, 40 * MB), view('new', 3, 40 * MB), view('mid', 2, 40 * MB)],
      100 * MB
    )
    expect(over).toEqual(new Set(['old']))
  })

  it('parks even the last-hidden view when it alone exceeds the budget', () => {
    const over = selectHiddenTerminalViewsOverBudget(
      [view('huge', 3, 500 * MB), view('small', 2, 10 * MB)],
      100 * MB
    )
    expect(over).toEqual(new Set(['huge']))
  })

  it('counts a view still inside the cold-park delay without parking it', () => {
    const over = selectHiddenTerminalViewsOverBudget(
      [view('just-hidden', 3, 90 * MB, false), view('older', 2, 20 * MB)],
      100 * MB
    )
    expect(over).toEqual(new Set(['older']))
  })

  // Why: it parks once its delay ends, so displacing an older view now would flip that view back.
  it('does not let a view that will not fit once it can park displace an older view', () => {
    const views = [
      view('newest', 3, 60 * MB),
      view('in-delay', 2, 50 * MB, false),
      view('old', 1, 30 * MB)
    ]
    expect(selectHiddenTerminalViewsOverBudget(views, 100 * MB)).toEqual(new Set())
    const afterDelay = views.map((v) => (v.tabId === 'in-delay' ? { ...v, parkable: true } : v))
    expect(selectHiddenTerminalViewsOverBudget(afterDelay, 100 * MB)).toEqual(new Set(['in-delay']))
  })

  it('always charges a view that stays mounted for another reason', () => {
    const over = selectHiddenTerminalViewsOverBudget(
      [{ ...view('sleeping', 3, 90 * MB), held: true }, view('older', 2, 20 * MB)],
      100 * MB
    )
    expect(over).toEqual(new Set(['older']))
  })

  it('never keeps a view whose size was never measured', () => {
    const over = selectHiddenTerminalViewsOverBudget(
      [view('unknown', 3, Number.POSITIVE_INFINITY), view('known', 2, 10 * MB)],
      100 * MB
    )
    expect(over).toEqual(new Set(['unknown']))
  })

  it('reserves older held memory before admitting newer ordinary views', () => {
    expect(
      selectHiddenTerminalViewsOverBudget(
        [view('newer', 2, 200 * MB), { ...view('held', 1, 300 * MB), held: true }],
        384 * MB
      )
    ).toEqual(new Set(['newer']))
  })

  it('reserves every held view before spending the remainder in recency order', () => {
    expect(
      selectHiddenTerminalViewsOverBudget(
        [
          view('old', 2, 40 * MB),
          view('new', 4, 40 * MB),
          { ...view('held-a', 1, 20 * MB), held: true },
          { ...view('held-b', 3, 30 * MB), held: true }
        ],
        100 * MB
      )
    ).toEqual(new Set(['old']))
  })

  it('parks ordinary views when held memory alone exceeds the allowance', () => {
    expect(
      selectHiddenTerminalViewsOverBudget(
        [view('new', 2, 10 * MB), { ...view('held', 1, 500 * MB), held: true }],
        384 * MB
      )
    ).toEqual(new Set(['new']))
  })

  it('reserves unknown held memory without bypassing the cold-park delay', () => {
    expect(
      selectHiddenTerminalViewsOverBudget(
        [
          view('in-delay', 3, 10 * MB, false),
          view('ordinary', 2, 10 * MB),
          { ...view('held', 1, Number.POSITIVE_INFINITY), held: true }
        ],
        384 * MB
      )
    ).toEqual(new Set(['ordinary']))
  })

  it('breaks a hidden-time tie by the later activation', () => {
    const over = selectHiddenTerminalViewsOverBudget(
      [
        { ...view('tab-aaa', 5, 60 * MB), activationSeq: 2 },
        { ...view('tab-zzz', 5, 60 * MB), activationSeq: 1 }
      ],
      100 * MB
    )
    expect(over).toEqual(new Set(['tab-zzz']))
  })
})

describe('reportHiddenTerminalViews', () => {
  beforeEach(() => {
    resetHiddenTerminalViewBudgetForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetHiddenTerminalViewBudgetForTest()
  })

  it('shares one budget across worktrees and wakes the worktree whose view no longer fits', () => {
    const listener = vi.fn()
    subscribeHiddenTerminalViewBudget('wt-a', listener)
    expect(reportHiddenTerminalViews('wt-a', [view('a-1', 1, 60 * MB)], 100 * MB)).toEqual(
      new Set()
    )

    expect(reportHiddenTerminalViews('wt-b', [view('b-1', 2, 60 * MB)], 100 * MB)).toEqual(
      new Set()
    )
    expect(listener).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(reportHiddenTerminalViews('wt-a', [view('a-1', 1, 60 * MB)], 100 * MB)).toEqual(
      new Set(['a-1'])
    )

    // Withdrawing wt-b's views frees the budget for wt-a again.
    reportHiddenTerminalViews('wt-b', [], 100 * MB)
    vi.runAllTimers()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(reportHiddenTerminalViews('wt-a', [view('a-1', 1, 60 * MB)], 100 * MB)).toEqual(
      new Set()
    )
  })

  it('does not wake the reporting worktree or one whose verdict is unchanged', () => {
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    subscribeHiddenTerminalViewBudget('wt-a', listenerA)
    subscribeHiddenTerminalViewBudget('wt-b', listenerB)
    reportHiddenTerminalViews('wt-a', [view('a-1', 1, 10 * MB)], 100 * MB)
    reportHiddenTerminalViews('wt-b', [view('b-1', 2, 10 * MB)], 100 * MB)
    reportHiddenTerminalViews('wt-a', [view('a-1', 1, 200 * MB)], 100 * MB)
    vi.runAllTimers()
    expect(listenerA).not.toHaveBeenCalled()
    expect(listenerB).not.toHaveBeenCalled()
  })
})

describe('buildHiddenTerminalViews', () => {
  beforeEach(() => resetHiddenTerminalViewBudgetForTest())

  function tab(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      ptyId: `wt-1@@${id}`,
      isVisible: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs: 10,
      ...overrides
    }
  }

  it('reports hidden restorable tabs and skips visible, portaled, clock-parked and unrestorable ones', () => {
    const views = buildHiddenTerminalViews(
      {
        worktreeId: 'wt-1',
        isHeldMounted: (held) => held.id === 'never',
        terminalTabs: [
          tab('hidden', { lastActivatedSeq: 4 }),
          tab('visible', { isVisible: true, hiddenSinceMs: null }),
          tab('portal', { hasActivityTerminalPortal: true }),
          tab('clock-parked'),
          tab('remote', { ptyId: 'remote:env-1@@terminal-1' })
        ],
        parkableTabIds: new Set(['hidden', 'clock-parked']),
        clockParkedTabIds: new Set(['clock-parked'])
      },
      new Map()
    )
    expect(views).toEqual([
      {
        tabId: 'hidden',
        hiddenSinceMs: 10,
        activationSeq: 4,
        bytes: Number.POSITIVE_INFINITY,
        parkable: true,
        held: false
      }
    ])
  })

  it('keeps the largest size seen while hidden, and measures afresh on the next hide', () => {
    const sizes = new Map<string, { hiddenSinceMs: number; bytes: number }>()
    let bytes = 50 * MB
    registerMountedTerminalTabView('tab-1', { getRetainedBytes: () => bytes })
    const input = (hiddenSinceMs: number) => ({
      worktreeId: 'wt-1',
      terminalTabs: [tab('tab-1', { hiddenSinceMs })],
      parkableTabIds: new Set(['tab-1']),
      clockParkedTabIds: new Set<string>()
    })
    expect(buildHiddenTerminalViews(input(10), sizes)[0].bytes).toBe(50 * MB)
    // A remount mid-restore reads small; the episode keeps the larger size.
    bytes = 5 * MB
    expect(buildHiddenTerminalViews(input(10), sizes)[0].bytes).toBe(50 * MB)
    // Shown and hidden again: a new episode measures what is there now.
    expect(buildHiddenTerminalViews(input(20), sizes)[0].bytes).toBe(5 * MB)
  })

  it('reports clock-expired held views only while their mounted source exists', () => {
    const sizes = new Map<string, { hiddenSinceMs: number; bytes: number }>()
    const input = {
      worktreeId: 'wt-1',
      terminalTabs: [tab('held')],
      parkableTabIds: new Set(['held']),
      clockParkedTabIds: new Set(['held']),
      isHeldMounted: () => true
    }
    const unregister = registerMountedTerminalTabView('held', { getRetainedBytes: () => 300 * MB })
    expect(buildHiddenTerminalViews(input, sizes)).toEqual([
      { tabId: 'held', hiddenSinceMs: 10, bytes: 300 * MB, parkable: true, held: true }
    ])
    unregister()
    expect(buildHiddenTerminalViews(input, sizes)).toEqual([])
  })

  it('charges a registered held view even when its size getter fails', () => {
    registerMountedTerminalTabView('held', {
      getRetainedBytes: () => {
        throw new Error('estimate unavailable')
      }
    })
    const views = buildHiddenTerminalViews(
      {
        worktreeId: 'wt-1',
        terminalTabs: [tab('held')],
        parkableTabIds: new Set(['held']),
        clockParkedTabIds: new Set(['held']),
        isHeldMounted: () => true
      },
      new Map()
    )
    expect(views).toEqual([
      {
        tabId: 'held',
        hiddenSinceMs: 10,
        bytes: Number.POSITIVE_INFINITY,
        parkable: true,
        held: true
      }
    ])
    expect(
      selectHiddenTerminalViewsOverBudget([...views, view('ordinary', 20, MB)], 384 * MB)
    ).toEqual(new Set(['ordinary']))
  })

  it('does not turn an unmounted sleeping owner into a held memory reservation', () => {
    const views = buildHiddenTerminalViews(
      {
        worktreeId: 'wt-1',
        terminalTabs: [tab('unmounted')],
        parkableTabIds: new Set(['unmounted']),
        clockParkedTabIds: new Set<string>(),
        isHeldMounted: () => true
      },
      new Map()
    )
    expect(views[0].held).toBe(false)
    expect(
      selectHiddenTerminalViewsOverBudget([...views, view('ordinary', 20, MB)], 384 * MB)
    ).toEqual(new Set(['unmounted']))
  })

  it('measures a mounted view and remembers its size after it parks', () => {
    const lastKnown = new Map<string, { hiddenSinceMs: number; bytes: number }>()
    const input = {
      worktreeId: 'wt-1',
      terminalTabs: [tab('tab-1')],
      parkableTabIds: new Set(['tab-1']),
      clockParkedTabIds: new Set<string>()
    }
    const unregister = registerMountedTerminalTabView('tab-1', { getRetainedBytes: () => 7 * MB })
    expect(buildHiddenTerminalViews(input, lastKnown)[0].bytes).toBe(7 * MB)
    unregister()
    expect(buildHiddenTerminalViews(input, lastKnown)[0].bytes).toBe(7 * MB)
    // A closed tab drops its remembered size.
    buildHiddenTerminalViews({ ...input, terminalTabs: [] }, lastKnown)
    expect(lastKnown.size).toBe(0)
  })
})

describe('selectColdParkedTerminalTabs with the hidden-view budget', () => {
  const nowMs = 500_000

  function hiddenTab(id: string, hiddenSinceMs: number) {
    return {
      id,
      ptyId: `wt-1@@${id}`,
      isVisible: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs
    }
  }

  it('adds the tabs the budget reports over it to the clock-parked set', () => {
    const seen: { parkable?: string[]; clockParked?: string[] } = {}
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        hiddenTab('tab-recent', nowMs - 31_000),
        hiddenTab('tab-aged', nowMs - 10 * 60_000),
        hiddenTab('tab-just-hidden', nowMs - 1_000)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hiddenViewBudget: (input) => {
        seen.parkable = Array.from(input?.parkableTabIds ?? []).sort()
        seen.clockParked = Array.from(input?.clockParkedTabIds ?? [])
        return new Set(['tab-recent'])
      }
    })
    expect(seen).toEqual({ parkable: ['tab-aged', 'tab-recent'], clockParked: ['tab-aged'] })
    expect(selected).toEqual(new Set(['tab-aged', 'tab-recent']))
  })

  it('withdraws from the budget when parking is off', () => {
    const budget = vi.fn(() => new Set<string>())
    selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [],
      pendingStartupByTabId: {},
      parkingEnabled: false,
      nowMs,
      hiddenViewBudget: budget
    })
    expect(budget).toHaveBeenCalledWith(null)
  })
})
