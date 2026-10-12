import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectMountedHiddenTerminalViewCounts,
  readMountedTerminalTabViewBytes,
  registerMountedTerminalTabView,
  resetMountedTerminalViewsForTest
} from './mounted-terminal-view-census'

const MB = 1024 * 1024

afterEach(resetMountedTerminalViewsForTest)

describe('mounted hidden terminal view census', () => {
  it('reads current visibility, restoration and bytes without any policy report', () => {
    let visible = false
    let restorable = false
    let bytes = 10 * MB
    registerMountedTerminalTabView('force-park-exempt', {
      getRetainedBytes: () => bytes,
      getHiddenState: () => (visible ? null : { restorable })
    })
    expect(collectMountedHiddenTerminalViewCounts([])).toMatchObject({
      unrestorableViews: 1,
      unrestorableKB: 10 * 1024
    })
    restorable = true
    bytes = 2 * MB
    expect(collectMountedHiddenTerminalViewCounts([])).toMatchObject({
      keptViews: 1,
      keptKB: 2 * 1024,
      unrestorableViews: 0
    })
    visible = true
    expect(collectMountedHiddenTerminalViewCounts([])).toEqual({
      keptViews: 0,
      keptKB: 0,
      overBudgetViews: 0,
      unrestorableViews: 0,
      unrestorableKB: 0
    })
  })

  it('counts a withheld pressure selection until its actual mount is disposed', () => {
    const unregister = registerMountedTerminalTabView('withheld', {
      getRetainedBytes: () => MB,
      getHiddenState: () => ({ restorable: true })
    })
    const selections = [new Set(['withheld', 'already-parked'])]
    expect(collectMountedHiddenTerminalViewCounts(selections).overBudgetViews).toBe(1)
    unregister()
    expect(collectMountedHiddenTerminalViewCounts(selections).overBudgetViews).toBe(0)
  })

  it('does not let an old disposer remove a successor mounted view', () => {
    const unregister = registerMountedTerminalTabView('tab', {
      getRetainedBytes: () => 10 * MB,
      getHiddenState: () => ({ restorable: true })
    })
    registerMountedTerminalTabView('tab', {
      getRetainedBytes: () => MB,
      getHiddenState: () => ({ restorable: true })
    })
    unregister()
    expect(readMountedTerminalTabViewBytes('tab')).toBe(MB)
    expect(collectMountedHiddenTerminalViewCounts([])).toMatchObject({ keptViews: 1, keptKB: 1024 })
  })

  it('does not measure visible views or let a broken source suppress other occupancy', () => {
    const measureVisible = vi.fn(() => MB)
    registerMountedTerminalTabView('visible', {
      getRetainedBytes: measureVisible,
      getHiddenState: () => null
    })
    registerMountedTerminalTabView('broken', {
      getRetainedBytes: () => MB,
      getHiddenState: () => {
        throw new Error('disposed')
      }
    })
    registerMountedTerminalTabView('unknown-size', {
      getRetainedBytes: () => {
        throw new Error('unavailable')
      },
      getHiddenState: () => ({ restorable: false })
    })
    registerMountedTerminalTabView('healthy', {
      getRetainedBytes: () => MB,
      getHiddenState: () => ({ restorable: true })
    })
    expect(collectMountedHiddenTerminalViewCounts([])).toMatchObject({
      keptViews: 1,
      keptKB: 1024,
      unrestorableViews: 1,
      unrestorableKB: 0
    })
    expect(measureVisible).not.toHaveBeenCalled()
  })
})
