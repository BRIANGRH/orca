// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { openAgentSessionHistoryModal } from './agent-session-history-modal'
import { resolveAiVaultPanelSessionListRequest } from './ai-vault-panel-session-list-request'

type Mocks = {
  scopePaths: (readonly string[])[]
  handleResumeInNewChat: Mock<(...args: unknown[]) => unknown>
  keyboardEnabled: boolean[]
  session: AiVaultSession
}

const mocks = vi.hoisted((): Mocks => ({
  scopePaths: [],
  handleResumeInNewChat: vi.fn(),
  keyboardEnabled: [],
  session: {
    id: 'local:claude:s-1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 's-1',
    title: 'Fix auth retry',
    cwd: '/repo/chat',
    branch: null,
    model: null,
    filePath: '/tmp/s-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-17T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume s-1',
    subagent: null
  }
}))

vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: (scopePaths: readonly string[]) => {
    mocks.scopePaths.push(scopePaths)
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
  useAiVaultSessionLaunchActions: () => ({
    continuationRequest: null,
    handleResume: vi.fn(),
    handleResumeInNewChat: mocks.handleResumeInNewChat,
    handleResumeInNewCli: vi.fn()
  })
}))
vi.mock('./ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({ jumpToOriginalPane: vi.fn(), jumpToWorktree: vi.fn() })
}))
vi.mock('./ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
// The list's rows and keys have their own tests; this one stands in for a row's Resume button.
vi.mock('./AiVaultSessionVirtualList', () => ({
  AiVaultSessionVirtualList: (props: {
    keyboardRef?: unknown
    onResumeInNewChat: (session: AiVaultSession, workspaceId: string) => void
  }) => {
    mocks.keyboardEnabled.push(props.keyboardRef !== undefined)
    return (
      <button type="button" onClick={() => props.onResumeInNewChat(mocks.session, 'wt-own')}>
        Resume row
      </button>
    )
  }
}))

import AiVaultSessionHistoryDialog from './AiVaultSessionHistoryDialog'
import AiVaultSidebarPanel from './AiVaultSidebarPanel'

const CHAT_WORKTREE = 'repo-1::/repo/chat'
const OTHER_WORKTREE = 'repo-1::/repo/other'

function Host({ withSidebar = false }: { withSidebar?: boolean }) {
  const open = useAppStore((s) => s.activeModal === 'agent-session-history')
  return (
    <TooltipProvider>
      <textarea aria-label="Composer" />
      {withSidebar ? (
        <div data-testid="sidebar">
          <AiVaultSidebarPanel />
        </div>
      ) : null}
      {open ? <AiVaultSessionHistoryDialog /> : null}
    </TooltipProvider>
  )
}

function openHistory(initialQuery = '') {
  act(() =>
    openAgentSessionHistoryModal({ workspace: { worktreeId: CHAT_WORKTREE }, initialQuery })
  )
}

function dialogSearch(): HTMLInputElement {
  return within(screen.getByRole('dialog')).getByLabelText<HTMLInputElement>('Search sessions')
}

beforeEach(() => {
  mocks.scopePaths.length = 0
  mocks.keyboardEnabled.length = 0
  mocks.handleResumeInNewChat.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeRepoId: 'repo-1',
    activeWorktreeId: OTHER_WORKTREE,
    repos: [makeRepo()],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(CHAT_WORKTREE, 'chat', { path: '/repo/chat' }),
        makeWorktree(OTHER_WORKTREE, 'other', { path: '/repo/other' })
      ]
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchSessions: vi.fn(() => new Promise(() => {})) } }
  })
})
afterEach(cleanup)

describe('Session History dialog', () => {
  it("opens on the chat's own workspace, with the search filled and focused", async () => {
    render(<Host />)
    screen.getByLabelText('Composer').focus()
    openHistory('auth')

    await waitFor(() => expect(dialogSearch()).toHaveFocus())
    expect(dialogSearch().value).toBe('auth')
    expect(
      screen.getByRole('radiogroup', { name: 'Session History scope: current workspace' })
    ).toBeInTheDocument()
    const chatRequest = resolveAiVaultPanelSessionListRequest(useAppStore.getState(), CHAT_WORKTREE)
    expect(mocks.scopePaths.at(-1)).toEqual(chatRequest.scopePaths)
    expect(mocks.keyboardEnabled.at(-1)).toBe(true)
  })

  it('clears a search on the first Escape, closes on the next, and hands focus back', async () => {
    render(<Host />)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())

    fireEvent.keyDown(dialogSearch(), { key: 'Escape' })
    expect(dialogSearch().value).toBe('')
    expect(useAppStore.getState().activeModal).toBe('agent-session-history')

    fireEvent.keyDown(dialogSearch(), { key: 'Escape' })
    expect(useAppStore.getState().activeModal).toBe('none')
    await waitFor(() => expect(composer).toHaveFocus())
  })

  it('leaves Escape to an open menu, and to an IME composition', async () => {
    render(<Host />)
    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())

    fireEvent.keyDown(dialogSearch(), { key: 'Escape', isComposing: true })
    expect(dialogSearch().value).toBe('auth')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Session History view options' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(dialogSearch().value).toBe('auth')
    expect(useAppStore.getState().activeModal).toBe('agent-session-history')
  })

  it('closes after a resume without pulling focus back to the chat', async () => {
    render(<Host />)
    const composer = screen.getByLabelText('Composer')
    composer.focus()
    openHistory()
    await waitFor(() => expect(dialogSearch()).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Resume row' }))

    expect(mocks.handleResumeInNewChat).toHaveBeenCalledWith(mocks.session, 'wt-own')
    expect(useAppStore.getState().activeModal).toBe('none')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(composer).not.toHaveFocus()
  })

  it('starts fresh on every opening', async () => {
    render(<Host />)
    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())
    fireEvent.change(dialogSearch(), { target: { value: 'auth retry' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(useAppStore.getState().activeModal).toBe('none')

    openHistory()
    await waitFor(() => expect(dialogSearch()).toHaveFocus())
    expect(dialogSearch().value).toBe('')
  })

  it("keeps its search apart from the sidebar's and leaves Settings' request to the sidebar", async () => {
    render(<Host withSidebar />)
    const sidebarSearch = within(screen.getByTestId('sidebar')).getByLabelText<HTMLInputElement>(
      'Search sessions'
    )
    fireEvent.change(sidebarSearch, { target: { value: 'sidebar text' } })
    // Rows from the sidebar list are not keyboard-selectable.
    expect(mocks.keyboardEnabled).toEqual(expect.arrayContaining([false]))

    openHistory('auth')
    await waitFor(() => expect(dialogSearch()).toHaveFocus())
    act(() => useAppStore.getState().showAiVaultSearch())

    expect(dialogSearch().value).toBe('auth')
    expect(sidebarSearch.value).toBe('sidebar text')
    expect(
      screen.getByRole('radiogroup', { name: 'Session History scope: current workspace' })
    ).toBeInTheDocument()
    // Only the sidebar consumes the request.
    expect(useAppStore.getState().aiVaultSearchFocusRequested).toBe(false)
  })
})
