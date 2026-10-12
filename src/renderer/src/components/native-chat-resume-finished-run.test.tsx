// @vitest-environment happy-dom
import { act } from 'react'
import {
  getStructuredAgentSessionReadOwner,
  retireStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './native-chat/structured-agent-session-read-owner'
import type {
  AgentSessionHistoryPage,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import type { Tab } from '../../../shared/tab-types'
import { expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  failure,
  offered,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartRun,
  refreshNativeChatRestartOffer,
  releaseFinishedNativeChatRestartRun
} from './native-chat-resume-on-restart-store'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { useAppStore } from '../store'
import { chatBox, namedBox } from './native-chat-resume-on-restart-modal.test-support'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const { mount, button, fakeHost, runStatus, toasts } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')?.textContent

const sourceSequences = new Map<string, number>()
beforeEach(() => {
  sourceSequences.clear()
  resetStructuredAgentSessionReadOwnersForTests()
})
afterEach(() => resetStructuredAgentSessionReadOwnersForTests())
function manualActivity(
  changes: Partial<AgentSessionStatusSummary> = {},
  proveSource = true
): void {
  const tab: Tab = {
    id: 'tab-b',
    entityId: 'b',
    worktreeId: 'workspace',
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Chat b',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  useAppStore.setState({ unifiedTabsByWorktree: { workspace: [tab] } })
  const session: AgentSessionStatusSummary = {
    sessionId: 'b',
    workspaceId: 'workspace',
    agent: 'codex',
    status: 'working',
    latestPrompt: '',
    updatedAt: Date.now(),
    hostExecutionOwned: true,
    hostExecutionPhase: 'ready',
    ...changes
  }
  statusStream.snapshot.set('b', session)
  statusStream.emit({ type: 'status', session })
  if (proveSource) {
    const sequence = (sourceSequences.get('b') ?? 0) + 1
    sourceSequences.set('b', sequence)
    const cursor = { epoch: 'resume-b', sequence }
    const page: AgentSessionHistoryPage = {
      sessionId: 'b',
      epoch: cursor.epoch,
      direction: 'tail',
      items: [],
      removedItemIds: [],
      hasOlder: false,
      hasNewer: false,
      fence: 2,
      liveCursor: cursor,
      window: { oldest: null, newest: null, nextCursor: cursor },
      submissions: [
        {
          clientMessageId: `user-${sequence}`,
          fence: 2,
          payloadFingerprint: 'payload',
          dispatchState: session.turnOutcome === 'failure' ? 'rejected' : 'accepted',
          providerItemId: `provider-${sequence}`,
          reason: null,
          submittedAt: 1,
          resolvedAt: 2,
          submittedSequence: sequence,
          origin: 'client',
          source: { kind: 'user' }
        }
      ]
    }
    retireStructuredAgentSessionReadOwner('b', { kind: 'local' })
    getStructuredAgentSessionReadOwner('b', { kind: 'local' }).publishCreated(page)
  }
}

async function mountSurfaces(): Promise<void> {
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
}

it.each(['status entry', 'toast Show'] as const)(
  'opens every finished result from %s after Resume closed the dialog',
  async (source) => {
    fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'), 'unknown')
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    expect(dialog()).toBeUndefined()
    await act(async () =>
      source === 'status entry' ? button('1 chat failed to resume').click() : lastToastShow()?.()
    )
    expect(dialog()).toContain('Resumed 1 of 2 chats')
    expect(dialog()).toContain('All2')
    expect(dialog()).toContain('Need you1')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t resume')
    expect(button('Retry')).toBeTruthy()
    expect(button('Open chat')).toBeTruthy()
    expect(button('Dismiss "Prompt b" in workspace')).toBeTruthy()
    expect(toasts()).toEqual([['1 chat couldn’t be resumed', 'Resumed 1 chat']])
  }
)

it.each(['status entry', 'toast Show'] as const)(
  'returns to the host failure offer from %s after the finished view is closed',
  async (source) => {
    fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    await act(async () => button('1 chat failed to resume').click())
    expect(dialog()).toContain('Resumed 1 of 2 chats')
    await act(async () => button('Close').click())
    await act(async () =>
      source === 'status entry' ? button('1 chat failed to resume').click() : lastToastShow()?.()
    )
    expect(dialog()).toContain('Resume interrupted chats?')
    expect(dialog()).toContain('Prompt b')
    expect(dialog()).not.toContain('Prompt a')
  }
)

it('keeps the unseen summary when a view was opened and closed only during the run', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'unknown'))
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  expect(dialog()).toContain('Resuming 2 chats')
  await act(async () => button('Close').click())
  await host.release('a', 'b')
  await act(async () => button('1 chat to check').click())
  expect(dialog()).toContain('Resumed 1 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
})

it.each(['status entry', 'toast Show'] as const)(
  'keeps a resumed entry until the all-success summary is seen from %s',
  async (source) => {
    fakeHost()
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    expect(dialog()).toBeUndefined()
    expect(button('2 chats resumed. Click to see them.').textContent).toBe('2 chats resumed')
    await act(async () =>
      source === 'status entry' ? button('2 chats resumed').click() : lastToastShow()?.()
    )
    expect(dialog()).toContain('Resumed 2 of 2 chats')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
    await act(async () => button('Done').click())
    expect(document.body.textContent).not.toContain('chat')
    await act(async () => lastToastShow()?.())
    expect(dialog()).toBeUndefined()
  }
)

it.each(['refused', 'unknown'] as const)(
  'keeps a %s chat in the result after confirmed manual recovery with an untouched offer',
  async (verdict) => {
    const untouched = { ...offered[0]!, sessionId: 'c', latestPrompt: 'Prompt c' }
    const host = fakeHost({ sessions: [...offered, untouched] }, (sessionId) =>
      sessionId === 'b' ? verdict : 'continued'
    )
    await mountSurfaces()
    await act(async () => chatBox('c').click())
    await act(async () => button('Resume 2 chats').click())
    expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
    await act(async () => manualActivity())
    host.state.failed = []
    await act(async () => refreshNativeChatRestartOffer())
    expect(button('2 chats resumed')).toBeTruthy()
    expect(button('1 chat available to resume')).toBeTruthy()
    await act(async () => button('1 chat available to resume').click())
    expect(dialog()).toContain('Resumed 2 of 2 chats')
    expect(dialog()).toContain('All3')
    expect(dialog()).toContain('Need you0')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
    expect(chatBox('c').getAttribute('aria-checked')).toBe('true')
    await act(async () => button('Resumed2').click())
    expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
    expect(dialog()).not.toContain('Prompt c')
    await act(async () => button('All3').click())
    await act(async () => button('Close').click())
    expect(getNativeChatRestartRun()).toBeNull()
    await act(async () => button('1 chat available to resume').click())
    expect(dialog()).toContain('Resume interrupted chats?')
    expect(dialog()).toContain('Prompt c')
    expect(dialog()).not.toContain('Prompt a')
    expect(dialog()).not.toContain('Prompt b')
    expect(button('Resume 1 chat').disabled).toBe(false)
  }
)

it.each(['refused', 'unknown'] as const)(
  'retains an unviewed %s result when opening and closing over a failed read',
  async (verdict) => {
    fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : verdict))
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    rpc.mockImplementationOnce(async () => {
      throw new Error('host unavailable')
    })
    await act(async () => lastToastShow()?.())
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(runStatus('Prompt b')).toBe(
      verdict === 'refused'
        ? 'Prompt b: Couldn’t resume'
        : 'Prompt b: Couldn’t confirm the chat was resumed'
    )
    expect(dialog()).toContain('All2')
    expect(dialog()).toContain('Need you1')
    expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
    await act(async () => button('Done').click())
    expect(getNativeChatRestartRun()?.entries).toHaveLength(2)
    expect(document.body.textContent).not.toContain('chat resumed')
    await act(async () => button('1 chat to check').click())
    expect(dialog()).toContain('Resumed 1 of 2 chats')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(runStatus('Prompt b')).not.toBeNull()
    expect(getNativeChatRestartRun()?.finishedViewShown).toBe(true)
    await act(async () => button('Close').click())
    expect(getNativeChatRestartRun()).toBeNull()
  }
)

it('does not establish manual recovery until a successful reread confirms the withdrawal', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => manualActivity())
  host.state.failed = []
  rpc.mockImplementationOnce(async () => ({ sessions: null }))
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t resume')
  expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
  await act(async () => refreshNativeChatRestartOffer())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  expect(getNativeChatRestartRun()?.finishedViewShown).toBe(true)
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
})

it('recognizes a manually sent message even after its agent has finished', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'unknown'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () =>
    manualActivity({
      latestPrompt: 'Continue with my changes',
      status: 'idle',
      turnOutcome: 'success',
      hostExecutionOwned: undefined,
      hostExecutionPhase: undefined,
      statusStartedAt: Date.now()
    })
  )
  host.state.failed = []
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
})

it('recognizes a later completed turn even when the user sends the same prompt', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'unknown'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () =>
    manualActivity({
      latestPrompt: '',
      status: 'idle',
      turnOutcome: 'success',
      statusStartedAt: 2,
      hostExecutionOwned: undefined,
      hostExecutionPhase: undefined
    })
  )
  host.state.failed = []
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
})

it.each(['reply', 'lost reply'] as const)(
  'does not call an explicit dismissal a manual resume after %s despite newer cached activity',
  async (delivery) => {
    const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'unknown'))
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    await act(async () => manualActivity())
    await act(async () => lastToastShow()?.())
    if (delivery === 'lost reply') {
      rpc.mockImplementationOnce(async () => {
        host.state.failed = []
        throw new Error('dismiss reply lost')
      })
    }
    await act(async () => button('Dismiss "Prompt b" in workspace').click())
    expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
    expect(dialog()).toContain('Resumed 1 of 2 chats')
    expect(dialog()).toContain('Need you0')
  }
)

it('does not report manual recovery when an accepted message fails to start its agent', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () =>
    manualActivity({
      latestPrompt: 'Continue with my changes',
      status: 'idle',
      turnOutcome: 'failure',
      statusStartedAt: 2,
      hostExecutionOwned: undefined,
      hostExecutionPhase: undefined
    })
  )
  host.state.failed = []
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
  expect(dialog()).toContain('Resumed 1 of 2 chats')
  expect(dialog()).toContain('Need you1')
})

it('keeps older-host withdrawal without positive activity unconfirmed', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'unknown'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () =>
    manualActivity(
      {
        latestPrompt: '',
        status: 'idle',
        statusStartedAt: undefined,
        hostExecutionOwned: undefined,
        hostExecutionPhase: undefined
      },
      false
    )
  )
  host.state.failed = []
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
  expect(dialog()).toContain('All2')
  expect(dialog()).toContain('Need you1')
  expect(dialog()).toContain('Resumed 1 of 2 chats')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
})

it('keeps a closed chat visible without attributing its cached activity to a resume', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => manualActivity({}, false))
  await act(async () => useAppStore.setState({ unifiedTabsByWorktree: { workspace: [] } }))
  host.state.failed = []
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Prompt b')
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
  expect(dialog()).toContain('Resumed 1 of 2 chats')
  expect(dialog()).toContain('Need you0')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
})

it.each(['later failure', 'closure'] as const)(
  'keeps a proven manual recovery in the unseen result after %s',
  async (later) => {
    const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'refused'))
    await mountSurfaces()
    await act(async () => button('Resume 2 chats').click())
    await act(async () => manualActivity())
    host.state.failed = []
    await act(async () => refreshNativeChatRestartOffer())
    expect(button('2 chats resumed')).toBeTruthy()
    await act(async () =>
      later === 'closure'
        ? useAppStore.setState({ unifiedTabsByWorktree: { workspace: [] } })
        : manualActivity({
            status: 'idle',
            turnOutcome: 'failure',
            hostExecutionOwned: undefined,
            hostExecutionPhase: undefined,
            statusStartedAt: 3
          })
    )
    expect(button('2 chats resumed')).toBeTruthy()
    await act(async () => button('2 chats resumed').click())
    expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
    expect(dialog()).toContain('Resumed 2 of 2 chats')
    expect(dialog()).toContain('Need you0')
  }
)

it('keeps an open unknown row in attention when the status feed ends', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => manualActivity({}, false))
  await act(async () => statusStream.emit({ type: 'end' }))
  host.state.failed = []
  await act(async () => refreshNativeChatRestartOffer())
  expect(button('1 chat to check')).toBeTruthy()
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Need you1')
})

it('keeps dismissal provenance after losing both the reply and immediate reread', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => manualActivity())
  await act(async () => lastToastShow()?.())
  rpc
    .mockImplementationOnce(async () => {
      host.state.failed = []
      throw new Error('lost dismiss reply')
    })
    .mockImplementationOnce(async () => {
      throw new Error('failed reread')
    })
  await act(async () => button('Dismiss "Prompt b" in workspace').click())
  await act(async () => refreshNativeChatRestartOffer())
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t confirm the chat was resumed')
  expect(dialog()).toContain('Resumed 1 of 2 chats')
})

it('uses a new user request identity for the same text after an already-ready unconfirmed run', async () => {
  const host = fakeHost(
    {},
    (id) => (id === 'a' ? 'continued' : 'unknown'),
    'unknown',
    (id) =>
      id === 'b' ? { hostExecutionOwned: true, hostExecutionPhase: 'ready', latestPrompt: '' } : {}
  )
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () =>
    manualActivity({ latestPrompt: '', statusStartedAt: 2, turnOutcome: 'success' })
  )
  host.state.failed = []
  await act(async () => refreshNativeChatRestartOffer())
  expect(button('2 chats resumed')).toBeTruthy()
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
})

it('lets a genuinely later same-text user request supersede dismissal', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => manualActivity())
  await act(async () => lastToastShow()?.())
  await act(async () => button('Dismiss "Prompt b" in workspace').click())
  expect(dialog()).toContain('Resumed 1 of 2 chats')
  await act(async () => manualActivity({ latestPrompt: '' }))
  host.state.failed = []
  await act(async () => refreshNativeChatRestartOffer())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
})

it('preserves established recovery through a failed reread without retiring the unseen result', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => manualActivity())
  host.state.failed = []
  await act(async () => refreshNativeChatRestartOffer())
  rpc.mockImplementationOnce(async () => {
    throw new Error('unavailable reread')
  })
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).not.toBeNull()
  await act(async () => lastToastShow()?.())
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
})

it('shows the resumed entry after a launch that resumed without asking', async () => {
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, nativeChatResumeWorkOnRestart: true }
  }))
  fakeHost()
  await mountSurfaces()
  expect(dialog()).toBeUndefined()
  await act(async () => button('2 chats resumed').click())
  expect(dialog()).toContain('Resumed 2 of 2 chats')
})

it('adds no resumed entry for a run watched to the end in the dialog', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await host.release('a', 'b')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  await act(async () => button('Done').click())
  expect(document.body.textContent).not.toContain('chat')
})

it('keeps a new successful run visible beside an older host failure', async () => {
  fakeHost({ sessions: [offered[0]!], failed: [failure('b')] })
  await mountSurfaces()
  await act(async () => button('Resume 1 chat').click())
  expect(button('1 chat failed to resume')).toBeTruthy()
  expect(button('1 chat resumed')).toBeTruthy()
  await act(async () => button('1 chat resumed').click())
  expect(dialog()).toContain('Resumed 1 of 1 chat')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
})

it('does not claim a mixed run succeeded when a host reread fails', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  rpc.mockImplementationOnce(async () => {
    throw new Error('host unavailable')
  })
  await act(async () => refreshNativeChatRestartOffer())
  expect(getNativeChatRestartRun()?.entries).toHaveLength(2)
  expect(document.body.textContent).not.toContain('chat resumed')
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Resumed 1 of 2 chats')
})

it('shows finished rows after resetting an in-flight filter and keeps later filter actions', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await act(async () => button('In progress2').click())
  await host.release('a', 'b')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  await act(async () => button('In progress0').click())
  expect(runStatus('Prompt a')).toBeNull()
  await act(async () => button('All2').click())
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
})

it('expands a group collapsed during a run before retiring the finished result', async () => {
  const host = fakeHost()
  host.hold('a', 'b')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await act(async () => button('Collapse workspace').click())
  expect(runStatus('Prompt a')).toBeNull()
  expect(runStatus('Prompt b')).toBeNull()
  await host.release('a', 'b')
  expect(dialog()).toContain('Resumed 2 of 2 chats')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).toBeNull()
  expect(document.body.textContent).not.toContain('chat resumed')
})

it('leaves the resumed chats to the failure entry when one could not resume', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  expect(button('1 chat failed to resume')).toBeTruthy()
  expect(document.body.textContent).not.toContain('resumed')
})

it('replaces the finished summary when Retry starts a new run', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'), 'unknown')
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('1 chat failed to resume').click())
  host.hold('b')
  await act(async () => button('Retry').click())
  expect(dialog()).toContain('Resuming 1 chat')
  expect(dialog()).not.toContain('Prompt a')
  await host.release('b')
  expect(dialog()).toContain('Resumed 0 of 1 chat')
})

it('selects only current offers from a workspace that also contains finished run history', async () => {
  const host = fakeHost()
  await mountSurfaces()
  await act(async () => chatBox('b').click())
  await act(async () => button('Resume 1 chat').click())
  await act(async () => lastToastShow()?.())
  const workspace = namedBox('Select all chats in workspace')
  expect(workspace.closest('label')?.textContent).toContain('1 of 1')
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  await act(async () => workspace.click())
  expect(chatBox('b').getAttribute('aria-checked')).toBe('false')
  await act(async () => workspace.click())
  expect(button('Resume 1 chat').disabled).toBe(false)
  host.hold('b')
  await act(async () => button('Resume 1 chat').click())
  expect(rpc.mock.calls.at(-1)?.[2]).toEqual({ sessionIds: ['b'] })
  await host.release('b')
})

it('does not consume a finished run if its requested view never rendered', async () => {
  fakeHost()
  await mountSurfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => {
    requestNativeChatResumeOnRestartDialog()
    consumeNativeChatResumeOnRestartDialogRequest()
    releaseFinishedNativeChatRestartRun()
  })
  expect(dialog()).toBeUndefined()
  await act(async () => lastToastShow()?.())
  expect(dialog()).toContain('Resumed 2 of 2 chats')
})

it('keeps the run out of settings and storage and loses it on a fresh renderer store', async () => {
  fakeHost({}, (sessionId) => (sessionId === 'a' ? 'continued' : 'refused'))
  await mountSurfaces()
  const settings = useAppStore.getState().settings
  const saveSettings = vi.fn(async () => {})
  useAppStore.setState({ updateSettings: saveSettings })
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  try {
    await act(async () => button('Resume 2 chats').click())
    expect(saveSettings).not.toHaveBeenCalled()
    expect(useAppStore.getState().settings).toBe(settings)
    expect(storage).not.toHaveBeenCalled()
    await mount(null)
    _resetNativeChatRestartOffer()
    expect(getNativeChatRestartRun()).toBeNull()
    await refreshNativeChatRestartOffer()
    await mountSurfaces()
    await act(async () => button('1 chat failed to resume').click())
    expect(dialog()).toContain('Resume interrupted chats?')
    expect(dialog()).not.toContain('Prompt a')
  } finally {
    storage.mockRestore()
  }
})
