// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type KeyboardEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultSessionListKeyboard } from './use-ai-vault-session-keyboard-navigation'

const VIEWPORT_PX = 600
const ROW_PX = 98

// The rich row is covered by its own tests; here only its details toggle and expansion matter.
vi.mock('./AiVaultSessionRow', () => ({
  VaultSessionRow: (props: {
    session: AiVaultSession
    detailsExpanded: boolean
    onToggleDetails: () => void
  }) => (
    <div data-testid="session-row" data-expanded={String(props.detailsExpanded)}>
      <button type="button" onClick={props.onToggleDetails}>
        {props.session.title}
      </button>
    </div>
  )
}))

import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function session(n: number): AiVaultSession {
  return {
    id: `local:claude:s-${n}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: `s-${n}`,
    title: `Session ${n}`,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/s-${n}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-17T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'Fix it', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume s-${n}`,
    subagent: null
  }
}

const sessions = Array.from({ length: 30 }, (_, n) => session(n))

function key(name: string, init: { repeat?: boolean; metaKey?: boolean } = {}) {
  const preventDefault = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only key, modifiers, repeat and preventDefault.
  const event = {
    key: name,
    repeat: init.repeat ?? false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: init.metaKey ?? false,
    preventDefault
  } as unknown as KeyboardEvent<HTMLElement>
  return { event, preventDefault }
}

function renderList(
  options: {
    groups?: AiVaultSessionListGroup[]
    collapsedGroups?: ReadonlySet<string>
    openSessionIds?: ReadonlySet<string>
    eligible?: (session: AiVaultSession) => boolean
    searchHits?: ReadonlyMap<string, AiVaultSearchHit>
  } = {}
) {
  const keyboard = createRef<AiVaultSessionListKeyboard>()
  const calls = {
    onJumpToOriginalPane: vi.fn(),
    onResumeInNewChat: vi.fn(),
    onActiveRowIdChange: vi.fn()
  }
  const groups = options.groups ?? [{ key: 'all', label: null, sessions }]
  render(
    <AiVaultSessionVirtualList
      groups={groups}
      collapsedGroups={options.collapsedGroups ?? new Set()}
      loading={false}
      sessionsCount={sessions.length}
      filteredSessionsCount={sessions.length}
      noAgentsSelected={false}
      error={null}
      vaultScope="workspace"
      buildResumeStartup={() => ({ command: '' })}
      getOriginalPaneTarget={() => null}
      isStructuredSessionOpen={(s) => options.openSessionIds?.has(s.id) ?? false}
      getSessionLiveState={() => null}
      getWorktreeInfo={() => null}
      getSessionResumeState={() => ({
        blocked: false,
        worktreeId: 'wt-1',
        usesSessionWorktree: true
      })}
      getSessionResumeActions={() => ({
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: 'wt-1', disabled: false }
      })}
      getSessionResumeInChat={(s) =>
        (options.eligible?.(s) ?? true)
          ? { available: true, workspaceId: `own-${s.sessionId}` }
          : { available: false, reason: 'remote' }
      }
      onToggleGroup={vi.fn()}
      onJumpToOriginalPane={calls.onJumpToOriginalPane}
      onJumpToWorktree={vi.fn()}
      onResume={vi.fn()}
      onContinueInNewSession={vi.fn()}
      onResumeInNewChat={calls.onResumeInNewChat}
      onResumeInNewCli={vi.fn()}
      onCopyResume={vi.fn()}
      onCopyId={vi.fn()}
      onCopyPath={vi.fn()}
      onOpenLog={vi.fn()}
      onRevealLog={vi.fn()}
      onOpenCwd={vi.fn()}
      onRequestDelete={vi.fn()}
      searchHits={options.searchHits}
      keyboardRef={keyboard}
      onActiveRowIdChange={calls.onActiveRowIdChange}
    />
  )
  const press = (name: string, init?: { repeat?: boolean; metaKey?: boolean }) => {
    const pressed = key(name, init)
    act(() => keyboard.current?.handleKeyDown(pressed.event))
    return pressed
  }
  return { calls, press }
}

function selectedTitle(): string | null {
  return document.querySelector('[data-selected="true"]')?.textContent ?? null
}

beforeEach(() => {
  // Why: happy-dom has no layout; give the virtualizer a bounded viewport and fixed rows.
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('overflow-y-auto') ? VIEWPORT_PX : ROW_PX
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isScroller = this.classList.contains('overflow-y-auto')
    return new DOMRect(0, 0, 400, isScroller ? VIEWPORT_PX : ROW_PX)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Session History keyboard selection', () => {
  it('starts on the first session and clamps at both ends', () => {
    const { press, calls } = renderList()
    expect(selectedTitle()).toBe('Session 0')
    expect(calls.onActiveRowIdChange).toHaveBeenLastCalledWith(
      document.querySelector('[data-selected="true"]')?.id
    )

    const up = press('ArrowUp')
    expect(up.preventDefault).toHaveBeenCalled()
    expect(selectedTitle()).toBe('Session 0')
    press('ArrowDown')
    press('ArrowDown')
    expect(selectedTitle()).toBe('Session 2')
  })

  it('keeps a far-off selected row mounted for the search box to name', () => {
    const { press } = renderList()
    for (let n = 0; n < 40; n += 1) {
      press('ArrowDown')
    }
    expect(selectedTitle()).toBe('Session 29')
    expect(screen.getAllByTestId('session-row').length).toBeLessThan(sessions.length)
  })

  it('skips group headers and the sessions of collapsed groups', () => {
    const { press } = renderList({
      groups: [
        { key: 'a', label: 'Alpha', sessions: sessions.slice(0, 2) },
        { key: 'b', label: 'Beta', sessions: sessions.slice(2, 4) },
        { key: 'c', label: 'Gamma', sessions: sessions.slice(4, 6) }
      ],
      collapsedGroups: new Set(['b'])
    })
    press('ArrowDown')
    press('ArrowDown')
    expect(selectedTitle()).toBe('Session 4')
  })

  it('follows a click and leaves the details toggle as it was', () => {
    const { press } = renderList()
    fireEvent.click(screen.getByText('Session 3'))
    expect(selectedTitle()).toBe('Session 3')
    expect(
      screen.getByText('Session 3').closest('[data-expanded]')?.getAttribute('data-expanded')
    ).toBe('true')
    press('ArrowDown')
    expect(selectedTitle()).toBe('Session 4')
  })

  it('resumes an eligible session once, in the workspace eligibility chose', () => {
    const { press, calls } = renderList()
    press('ArrowDown')
    const enter = press('Enter')
    press('Enter', { repeat: true })
    expect(enter.preventDefault).toHaveBeenCalled()
    expect(calls.onResumeInNewChat).toHaveBeenCalledExactlyOnceWith(sessions[1], 'own-s-1')
  })

  it('switches to an already-open session instead of opening a second one', () => {
    const { press, calls } = renderList({ openSessionIds: new Set([sessions[0].id]) })
    press('Enter')
    expect(calls.onJumpToOriginalPane).toHaveBeenCalledExactlyOnceWith(sessions[0])
    expect(calls.onResumeInNewChat).not.toHaveBeenCalled()
  })

  it('opens details, and launches nothing, when the row offers no chat action', () => {
    const missing: AiVaultSearchHit = {
      agent: 'claude',
      sessionId: 's-1',
      title: 'Session 1',
      cwd: '/repo',
      branch: null,
      updatedAt: null,
      messageCount: 2,
      score: 1,
      source: { presence: 'missing' },
      evidence: null
    }
    const { press, calls } = renderList({
      eligible: (s) => s.id !== sessions[0].id,
      searchHits: new Map([[sessions[1].id, missing]])
    })
    press('Enter')
    press('ArrowDown')
    press('Enter')
    expect(calls.onResumeInNewChat).not.toHaveBeenCalled()
    expect(calls.onJumpToOriginalPane).not.toHaveBeenCalled()
    const expanded = screen
      .getAllByTestId('session-row')
      .filter((row) => row.getAttribute('data-expanded') === 'true')
    expect(expanded.map((row) => row.textContent)).toEqual(['Session 0', 'Session 1'])
  })

  it('leaves modified keys to whoever else handles them', () => {
    const { press, calls } = renderList()
    const chord = press('Enter', { metaKey: true })
    expect(chord.preventDefault).not.toHaveBeenCalled()
    expect(calls.onResumeInNewChat).not.toHaveBeenCalled()
  })
})
