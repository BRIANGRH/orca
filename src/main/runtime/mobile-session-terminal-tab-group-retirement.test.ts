import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { retireProvenTerminalTabFrom } from './mobile-session-terminal-tab-retirement'
import { chooseActiveSurface } from './mobile-session-terminal-retirement'

const terminal: RuntimeMobileSessionSnapshotTab = {
  type: 'terminal',
  id: 'terminal::leaf',
  parentTabId: 'terminal',
  leafId: 'leaf',
  ptyId: 'pty',
  title: 'Terminal',
  isActive: false
}
const browser: RuntimeMobileSessionSnapshotTab = {
  type: 'browser',
  id: 'browser-row',
  browserWorkspaceId: 'browser-workspace',
  browserPageId: 'page',
  title: 'Browser',
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}
const survivor: RuntimeMobileSessionSnapshotTab = {
  ...terminal,
  id: 'survivor::leaf',
  parentTabId: 'survivor',
  ptyId: 'survivor-pty'
}
const proof = {
  parentTabId: 'terminal',
  leafId: 'leaf',
  ptyId: 'pty',
  terminal: 'host-terminal',
  incarnationId: 'incarnation'
}

function splitSnapshot(
  browserOrderId: string,
  survivorOrderId: string
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'folder-workspace',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 4,
    activeGroupId: 'right',
    activeTabId: browser.id,
    activeTabType: 'browser',
    tabGroups: [
      {
        id: 'left',
        activeTabId: survivorOrderId,
        tabOrder: ['terminal', survivorOrderId],
        recentTabIds: ['terminal', survivorOrderId]
      },
      {
        id: 'right',
        activeTabId: browserOrderId,
        tabOrder: [browserOrderId],
        recentTabIds: [browserOrderId]
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'left' },
      second: { type: 'leaf', groupId: 'right' }
    },
    tabs: [terminal, survivor, browser]
  }
}

describe('proven terminal tab retirement preserves group identities', () => {
  it.each([
    ['browser-row', 'survivor'],
    ['browser-workspace', 'survivor'],
    ['browser-row', 'survivor::leaf'],
    ['browser-workspace', 'survivor::leaf']
  ])(
    'keeps browser %s and terminal %s groups, layout and active pointers',
    (browserId, survivorId) => {
      const snapshot = splitSnapshot(browserId, survivorId)
      const next = retireProvenTerminalTabFrom(snapshot, 'terminal', [proof])

      expect(next?.tabs.map((tab) => tab.id)).toEqual([survivor.id, browser.id])
      expect(next?.tabGroups).toEqual([
        {
          id: 'left',
          activeTabId: survivorId,
          tabOrder: [survivorId],
          recentTabIds: [survivorId]
        },
        snapshot.tabGroups?.[1]
      ])
      expect(next?.tabGroupLayout).toEqual(snapshot.tabGroupLayout)
      expect(next?.activeGroupId).toBe('right')
      expect(next?.activeTabId).toBe(browser.id)
      expect(next?.activeTabType).toBe('browser')
      expect(next?.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual([browser.id])
      expect(next?.retiredTerminalSurfaces).toEqual([proof])
      expect(next?.snapshotVersion).toBe(5)
      expect(next?.publicationEpoch).toBe(snapshot.publicationEpoch)
    }
  )

  it.each(['browser-row', 'browser-workspace'])(
    'selects the active group browser by %s when the previous surface was retired',
    (browserId) => {
      const snapshot = splitSnapshot(browserId, 'survivor')
      const tabs = [survivor, { ...browser, isActive: false }]
      expect(chooseActiveSurface(tabs, terminal.id, snapshot.tabGroups, 'right')?.id).toBe(
        browser.id
      )
    }
  )
})
