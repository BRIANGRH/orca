// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { resolveAiVaultPanelSessionListRequest } from './ai-vault-panel-session-list-request'
import { selectAiVaultPanelWorkspace } from './ai-vault-panel-workspace'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  writeAiVaultViewOptions,
  readAiVaultViewOptions
} from './ai-vault-view-options-persistence'

type PanelRequest = {
  scopePaths: readonly string[]
  executionHostScope: string
  sessionLimit: number | 'unlimited'
}

const panelRequests = vi.hoisted((): PanelRequest[] => [])

vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: (
    scopePaths: PanelRequest['scopePaths'],
    executionHostScope: PanelRequest['executionHostScope'],
    sessionLimit: PanelRequest['sessionLimit']
  ) => {
    panelRequests.push({ scopePaths, executionHostScope, sessionLimit })
    return {
      error: null,
      loading: false,
      refresh: vi.fn(),
      scanResult: null,
      sessions: [],
      loadedSessionLimit: null
    }
  }
}))
vi.mock('./ai-vault-session-launch-actions', () => ({
  useAiVaultSessionLaunchActions: () => ({ continuationRequest: null })
}))
vi.mock('./ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({})
}))
vi.mock('./ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
vi.mock('./AiVaultSessionVirtualList', () => ({ AiVaultSessionVirtualList: () => null }))

const WORKTREE_ID = 'repo-1::/repo/wt'
const SIBLING_ID = 'repo-1::/repo/sibling'

beforeEach(() => {
  panelRequests.length = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  writeAiVaultViewOptions({ ...readAiVaultViewOptions(), sessionLimit: 500 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions: vi.fn() }, ui: { writeClipboardText: vi.fn() } }
  })
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

it('builds the exact request the Session History panel sends for the active workspace', async () => {
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  render(<AiVaultPanel />)

  const request = resolveAiVaultPanelSessionListRequest(useAppStore.getState(), WORKTREE_ID)
  expect(request.scopePaths.length).toBeGreaterThan(1)
  expect(request.sessionLimit).toBe(500)
  expect(panelRequests.at(-1)).toEqual(request)
})

it("scopes a chat's panel to the chat's workspace while another one is active", async () => {
  const { default: AiVaultPanel } = await import('./AiVaultPanel')
  useAppStore.setState({ activeWorktreeId: SIBLING_ID })
  render(<AiVaultPanel workspace={{ worktreeId: WORKTREE_ID }} />)

  const state = useAppStore.getState()
  const bound = resolveAiVaultPanelSessionListRequest(state, WORKTREE_ID)
  expect(panelRequests.at(-1)).toEqual(bound)
  expect(bound).not.toEqual(resolveAiVaultPanelSessionListRequest(state, SIBLING_ID))
  expect(bound.scopePaths).toContain('/repo/wt')
})

it('resolves a repeated worktree id on the host the chat runs on', () => {
  useAppStore.setState({
    activeWorktreeId: null,
    repos: [
      { ...makeRepo(), id: 'repo-a', executionHostId: 'ssh:a' },
      { ...makeRepo(), id: 'repo-b', executionHostId: 'ssh:b' }
    ],
    worktreesByRepo: {
      'repo-a': [makeWorktree('same-id', 'a', { repoId: 'repo-a', path: '/a', hostId: 'ssh:a' })],
      'repo-b': [makeWorktree('same-id', 'b', { repoId: 'repo-b', path: '/b', hostId: 'ssh:b' })]
    }
  })
  const rows = selectAiVaultPanelWorkspace(useAppStore.getState(), {
    worktreeId: 'same-id',
    executionHostId: 'ssh:b'
  })
  expect(rows.worktree?.path).toBe('/b')
  expect(rows.repo?.id).toBe('repo-b')
})

it('resolves a folder workspace the way the sidebar does', () => {
  const folder: FolderWorkspace = {
    id: 'notes',
    projectGroupId: 'group-1',
    name: 'Notes',
    folderPath: '/notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  useAppStore.setState({ folderWorkspaces: [folder] })
  const rows = selectAiVaultPanelWorkspace(useAppStore.getState(), { worktreeId: 'folder:notes' })
  expect(rows.worktree?.path).toBe('/notes')
})
