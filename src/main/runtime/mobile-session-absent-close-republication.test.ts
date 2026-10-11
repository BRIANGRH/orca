import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  adjudicateAbsentMobileSessionTabClose,
  type MobileSessionLifecycleCloseContext,
  type MobileSessionLifecycleCloseHost
} from './mobile-session-lifecycle-close-adjudication'

const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'folder-workspace',
  publicationEpoch: 'renderer:1',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: 'parent::live',
  activeTabType: 'terminal',
  tabs: [
    {
      type: 'terminal',
      id: 'parent::live',
      parentTabId: 'parent',
      leafId: 'live',
      title: 'Live',
      isActive: true
    }
  ]
}

function liveParentContext(closeLeafId: string | null): MobileSessionLifecycleCloseContext {
  return {
    closeParentTabId: 'parent',
    closeLeafId,
    parentLeaves: snapshot.tabs.filter((tab) => tab.type === 'terminal'),
    rendererLeaves: [],
    leafHasConnectedPty: () => true,
    rendererLeafHasConnectedPty: () => false
  }
}

function host(): MobileSessionLifecycleCloseHost {
  return {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    findPtyForMobileTerminalTab: () => null,
    republishSnapshot: vi.fn()
  }
}

describe('refusing an absent surface under a live terminal parent', () => {
  it('marks the parent snapshot actually republished after a refused lifecycle close', () => {
    const runtime = host()
    const result = adjudicateAbsentMobileSessionTabClose({
      host: runtime,
      context: liveParentContext(null),
      worktreeId: snapshot.worktree,
      snapshot,
      reason: 'cleanup',
      addressedByPtyCloseAuthority: false
    })

    expect(runtime.republishSnapshot).toHaveBeenCalledWith(snapshot.worktree)
    expect(result).toEqual({
      closed: true,
      refused: true,
      refusalReason: 'live-host-pty',
      snapshotRepublished: true
    })
  })

  it.each([null, 'dead-leaf'])('keeps the marker absent without a republish for %s', (leafId) => {
    const runtime = host()
    const result = adjudicateAbsentMobileSessionTabClose({
      host: runtime,
      context: liveParentContext(leafId),
      worktreeId: snapshot.worktree,
      snapshot: leafId ? snapshot : undefined,
      reason: 'pty-exit',
      addressedByPtyCloseAuthority: false
    })

    expect(runtime.republishSnapshot).not.toHaveBeenCalled()
    expect(result).toEqual({ closed: true, refused: true, refusalReason: 'live-host-pty' })
  })
})
