import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { retireMobileSessionTabFrom } from './mobile-session-tab-retirement'

const terminal: RuntimeMobileSessionSnapshotTab = {
  type: 'terminal',
  id: 't1::leaf',
  parentTabId: 't1',
  leafId: 'leaf',
  title: 'Terminal',
  isActive: false
}

const browser: RuntimeMobileSessionSnapshotTab = {
  type: 'browser',
  id: 'browser-1',
  title: 'Browser',
  browserWorkspaceId: 'browser-workspace-1',
  browserPageId: 'page-1',
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

const editor: RuntimeMobileSessionSnapshotTab = {
  type: 'markdown',
  id: 'editor-1',
  title: 'README.md',
  filePath: '/w/README.md',
  relativePath: 'README.md',
  language: 'markdown',
  mode: 'edit',
  isDirty: false,
  isActive: false,
  sourceFileId: 'file-1',
  sourceFilePath: '/w/README.md',
  sourceRelativePath: 'README.md',
  documentVersion: '1'
}

/** A split: terminal + editor on the left, the browser alone on the right and active. */
function splitSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt',
    publicationEpoch: 'renderer:1',
    snapshotVersion: 4,
    activeGroupId: 'right',
    activeTabId: browser.id,
    activeTabType: 'browser',
    tabGroups: [
      { id: 'left', activeTabId: editor.id, tabOrder: ['t1', editor.id], recentTabIds: ['t1'] },
      { id: 'right', activeTabId: browser.id, tabOrder: [browser.id] }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'left' },
      second: { type: 'leaf', groupId: 'right' }
    },
    tabs: [terminal, editor, browser]
  }
}

describe('retireMobileSessionTabFrom', () => {
  it('drops a group the tab leaves empty, with its layout leaf and the active pointers', () => {
    const next = retireMobileSessionTabFrom(splitSnapshot(), browser.id)

    expect(next?.tabGroups?.map((group) => group.id)).toEqual(['left'])
    expect(next?.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'left' })
    expect(next?.activeGroupId).toBe('left')
    expect(next?.activeTabId).toBe(editor.id)
    expect(next?.activeTabType).toBe('markdown')
    expect(next?.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual([editor.id])
    expect(next?.snapshotVersion).toBe(5)
    expect(next?.publicationEpoch).toBe('renderer:1')
  })

  it('moves a group off a closed active tab to one it still holds', () => {
    const next = retireMobileSessionTabFrom(splitSnapshot(), editor.id)

    expect(next?.tabGroups).toEqual([
      { id: 'left', activeTabId: 't1', tabOrder: ['t1'], recentTabIds: ['t1'] },
      { id: 'right', activeTabId: browser.id, tabOrder: [browser.id] }
    ])
    expect(next?.activeGroupId).toBe('right')
    expect(next?.activeTabId).toBe(browser.id)
    expect(next?.tabGroupLayout).toEqual(splitSnapshot().tabGroupLayout)
  })

  it('drops a recent-tab list that named only the closed tab', () => {
    const snapshot = splitSnapshot()
    const recentEditorOnly = {
      ...snapshot,
      tabGroups: snapshot.tabGroups?.map((group) =>
        group.id === 'left' ? { ...group, recentTabIds: [editor.id] } : group
      )
    }

    const left = retireMobileSessionTabFrom(recentEditorOnly, editor.id)?.tabGroups?.[0]

    expect(left).toEqual({ id: 'left', activeTabId: 't1', tabOrder: ['t1'] })
  })

  it('removes a browser the group order names by its workspace id', () => {
    const snapshot = splitSnapshot()
    const byWorkspace = {
      ...snapshot,
      tabGroups: snapshot.tabGroups?.map((group) =>
        group.id === 'right' ? { ...group, tabOrder: ['browser-workspace-1'] } : group
      )
    }

    expect(retireMobileSessionTabFrom(byWorkspace, browser.id)?.tabGroups).toHaveLength(1)
  })

  it('keeps an absent group list absent, and answers null for a tab it does not list', () => {
    const { tabGroups: _groups, tabGroupLayout: _layout, ...ungrouped } = splitSnapshot()

    const next = retireMobileSessionTabFrom(ungrouped, browser.id)

    expect(next?.tabGroups).toBeUndefined()
    expect(next?.activeTabId).toBe(terminal.id)
    expect(retireMobileSessionTabFrom(ungrouped, 'missing')).toBeNull()
  })
})
