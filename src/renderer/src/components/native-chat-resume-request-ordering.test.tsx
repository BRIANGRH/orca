// @vitest-environment happy-dom
import React, { act } from 'react'
import {
  sendStructuredAgentSessionMessage,
  resetStructuredAgentSessionSendsForTests
} from './native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './native-chat/structured-agent-session-send-attempt'
import { admitUserResumeRequest } from './native-chat-resume-user-action.test-support'
import { beforeEach, afterEach, expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import {
  refreshNativeChatRestartOffer,
  dismissNativeChatRestartOffer,
  getNativeChatRestartOffer,
  getNativeChatRestartRun
} from './native-chat-resume-on-restart-store'
import { useAppStore } from '../store'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './native-chat/structured-agent-session-read-owner'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({ emit: () => {}, snapshot: new Map() }))
const streams = vi.hoisted(() => new Map<string, (event: AgentSessionSubscribeEvent) => void>())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSession: async (
    _target: unknown,
    params: { sessionId: string },
    emit: (event: AgentSessionSubscribeEvent) => void
  ) => {
    streams.set(params.sessionId, emit)
    return { unsubscribe: () => streams.delete(params.sessionId) }
  },
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
const { mount, button, fakeHost, runStatus } = createResumeModalFixture(rpc, statusStream)
const releases: (() => void)[] = []
beforeEach(() => {
  streams.clear()
  resetStructuredAgentSessionReadOwnersForTests()
})
afterEach(() => {
  releases.splice(0).forEach((release) => release())
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionSendsForTests()
  vi.useRealTimers()
})
function source(
  sequence: number,
  change: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: `user-${sequence}`,
    fence: 2,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: `provider-${sequence}`,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    submittedSequence: sequence,
    origin: 'client',
    source: { kind: 'user' },
    ...change
  }
}
function page(
  sequence: number,
  submissions: AgentJournalSubmission[] = []
): AgentSessionHistoryPage {
  const cursor = { epoch: 'resume-b', sequence }
  return {
    sessionId: 'b',
    epoch: cursor.epoch,
    direction: 'tail',
    fence: 2,
    items: [],
    submissions,
    removedItemIds: [],
    hasOlder: false,
    hasNewer: false,
    liveCursor: cursor,
    window: { oldest: null, newest: null, nextCursor: cursor }
  }
}
function visibleOwner(sequence = 7) {
  const owner = getStructuredAgentSessionReadOwner('b', { kind: 'local' })
  owner.publishCreated(page(sequence))
  releases.push(owner.activate())
  useAppStore.setState({
    unifiedTabsByWorktree: {
      workspace: [
        {
          id: 'tab-b',
          entityId: 'b',
          worktreeId: 'workspace',
          groupId: 'group',
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          label: 'b',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  })
  return owner
}
function emit(sequence: number, submissions: AgentJournalSubmission[]) {
  const listener = streams.get('b')
  if (!listener) {
    throw new Error('Missing active normal chat reader')
  }
  listener({ type: 'snapshot', sessionId: 'b', fence: 2, page: page(sequence, submissions) })
}
async function surfaces() {
  await mount(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(NativeChatResumeOnRestartModal),
      React.createElement(NativeChatResumeStatusSegment, { iconOnly: false })
    )
  )
}
it.each(['reply', 'lost reply plus failed read'] as const)(
  'does not credit a source predating Dismiss delivered after %s',
  async (delivery) => {
    const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
    visibleOwner()
    await surfaces()
    await act(async () => button('Resume 2 chats').click())
    // The host accepted user-8 before Dismiss, but its stream is delayed; the reader still has 7.
    await act(async () => admitUserResumeRequest('b', 'user-8'))
    await act(async () => lastToastShow()?.())
    if (delivery !== 'reply') {
      rpc.mockImplementationOnce(async () => {
        host.state.failed = []
        throw new Error('lost dismiss reply')
      })
      rpc.mockImplementationOnce(async () => {
        throw new Error('immediate read failed')
      })
    }
    await act(async () => button('Dismiss "Prompt b" in workspace').click())
    expect(getNativeChatRestartRun()?.entries[1]?.dismissal?.cursor?.sequence).toBe(7)
    await act(async () => emit(8, [source(8)]))
    await act(async () => refreshNativeChatRestartOffer())
    expect.soft(host.state.failed).toEqual([])
    expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
  }
)
it('keeps an accepted manual send after the row refused but before the whole bulk settles', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'refused'))
  host.hold('a')
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  expect(getNativeChatRestartRun()?.inFlight).toBe(true)
  expect(statusStream.snapshot.get('b')?.restartResume?.phase).toBe('refused')
  // Chat first opens while another row still holds the batch. Hydration itself precedes Send.
  await act(async () => {
    visibleOwner()
  })
  await act(async () => emit(8, [source(8)]))
  host.state.failed = []
  await host.release('a')
  await act(async () => lastToastShow()?.())
  expect.soft(getNativeChatRestartRun()?.entries[1]?.sourceCursor?.sequence).toBe(7)
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
})
it.each(['unavailable', 'confirmed-failure'] as const)(
  'does not use a pre-settlement empty read when its required source reread reports %s',
  async (newer) => {
    const host = fakeHost()
    visibleOwner()
    await surfaces()
    // The RPC reply is lost while the host still holds a reservation; listing is empty at this time.
    rpc.mockImplementationOnce(async () => {
      throw new Error('bulk reply lost while host still running')
    })
    rpc.mockImplementationOnce(async () => ({ sessions: [], failed: [] }))
    await act(async () => button('Resume 2 chats').click())
    const beforeSource = Promise.withResolvers<unknown>()
    const afterSource = Promise.withResolvers<unknown>()
    rpc.mockImplementationOnce(() => beforeSource.promise)
    await act(async () => button('1 chat to check').click())
    // The host files its original refusal, then accepts a user Send into the continuation's child.
    // The real-host seams establish that its old empty answer and newer refusal can occur in this order.
    host.state.failed = [failure('b')]
    rpc.mockImplementationOnce(() => afterSource.promise)
    await act(async () => emit(8, [source(8)]))
    expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
    await act(async () => beforeSource.resolve({ sessions: [], failed: [] }))
    await act(async () => {
      if (newer === 'unavailable') {
        afterSource.reject(new Error('required newer read unavailable'))
      } else {
        afterSource.resolve({ sessions: [], failed: host.state.failed })
      }
    })
    expect.soft(getNativeChatRestartOffer().available).toBe(newer !== 'unavailable')
    expect.soft(host.state.failed).toHaveLength(1)
    if (newer === 'unavailable') {
      expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
    } else {
      expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer?.failure).toBeDefined()
    }
    expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
  }
)
it('recognizes an explicit card Send whose producer states client origin but no source kind', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'refused'))
  visibleOwner()
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () =>
    emit(8, [source(8, { source: undefined, queuedMessageId: 'kept-message' })])
  )
  host.state.failed = []
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
})

it('distinguishes same-text new IDs from delayed host continuation and preserves confirmed history', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  const owner = visibleOwner()
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  // Old future-dated user and own host continuation do not qualify despite newer receipt times.
  await act(async () =>
    emit(8, [
      source(5, { submittedAt: Number.MAX_SAFE_INTEGER }),
      source(8, { clientMessageId: 'own-continuation', source: undefined, origin: 'host' })
    ])
  )
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest).toBeUndefined()
  await act(async () =>
    emit(9, [
      source(9, { clientMessageId: 'new-same-text', fence: 3, submittedAt: -1, resolvedAt: -1 })
    ])
  )
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.submission.clientMessageId).toBe(
    'new-same-text'
  )
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer?.failure).toBeDefined()
  host.state.failed = []
  await act(async () => refreshNativeChatRestartOffer())
  expect(button('2 chats resumed')).toBeDefined()
  // A later failure, closure, and global unavailable read cannot erase established acceptance.
  await act(async () => emit(10, [source(10, { dispatchState: 'rejected', providerItemId: null })]))
  await act(async () => useAppStore.setState({ unifiedTabsByWorktree: { workspace: [] } }))
  rpc.mockImplementationOnce(async () => {
    throw new Error('unavailable')
  })
  await act(async () => lastToastShow()?.())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
  expect(
    [...document.querySelectorAll('button')].some((node) =>
      /^(Retry|Dismiss all|Resume \d+ chat)/.test(node.textContent?.trim() ?? '')
    )
  ).toBe(false)
  expect(owner.hasActiveReaders()).toBe(true)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you0')
  await act(async () => button('Resumed2').click())
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
  await act(async () => button('Done').click())
  expect(getNativeChatRestartRun()).not.toBeNull()
})
it('does not reuse an already-published empty answer when newly observed evidence reread fails', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  visibleOwner()
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  host.state.failed = []
  await act(async () => refreshNativeChatRestartOffer())
  rpc.mockImplementationOnce(async () => {
    throw new Error('required reread fails')
  })
  await act(async () => emit(8, [source(8)]))
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
  expect(getNativeChatRestartOffer().available).toBe(false)
  rpc.mockImplementationOnce(async () => {
    throw new Error('unavailable open')
  })
  await act(async () => button('1 chat to check').click())
  expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
  expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
})
it('allows a proven newer user ID to supersede a completed dismissal, excluding own continuation', async () => {
  fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  visibleOwner()
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => emit(8, [source(8)]))
  await act(async () => lastToastShow()?.())
  await act(async () => button('Dismiss "Prompt b" in workspace').click())
  expect(getNativeChatRestartRun()?.entries[1]?.dismissal?.previousRequestId).toBe('user-8')
  await act(async () =>
    emit(9, [source(8), source(9, { clientMessageId: 'own', source: undefined, origin: 'host' })])
  )
  expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
  await act(async () => {
    admitUserResumeRequest('b', 'genuinely-later-user')
    emit(10, [source(8), source(10, { clientMessageId: 'genuinely-later-user' })])
  })
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
})

it.each(['unavailable', 'confirmed failure'] as const)(
  'waits for a genuinely newer read after in-flight manual recovery reports %s',
  async (mode) => {
    const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'refused'))
    host.hold('a')
    await surfaces()
    await act(async () => button('Resume 2 chats').click())
    await act(async () => {
      visibleOwner()
      admitUserResumeRequest('b', 'user-8')
      emit(8, [source(8)])
    })
    expect(getNativeChatRestartRun()?.inFlight).toBe(true)
    expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
    host.state.failed = []
    const base = rpc.getMockImplementation()
    rpc.mockImplementation(async (target, method, params) => {
      if (method === 'agentSession.restartResumable') {
        if (mode === 'unavailable') {
          throw new Error('post-witness read failed')
        }
        return { sessions: [], failed: [failure('b')] }
      }
      return base?.(target, method, params)
    })
    await act(async () => host.release('a'))
    expect(getNativeChatRestartRun()?.inFlight).toBe(false)
    expect(getNativeChatRestartOffer().available).toBe(mode !== 'unavailable')
    await act(async () => lastToastShow()?.())
    expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
    if (!base) {
      throw new Error('missing host implementation')
    }
    rpc.mockImplementation(base)
    await act(async () => refreshNativeChatRestartOffer())
    expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed2')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you0')
  }
)

it.each(['unavailable', 'failure'] as const)(
  'retains the latest %s after an older empty read arrives last',
  async (mode) => {
    const host = fakeHost()
    visibleOwner()
    await surfaces()
    rpc.mockImplementationOnce(async () => {
      throw new Error('lost bulk reply')
    })
    rpc.mockImplementationOnce(async () => ({ sessions: [], failed: [] }))
    await act(async () => button('Resume 2 chats').click())
    const old = Promise.withResolvers<unknown>()
    const newer = Promise.withResolvers<unknown>()
    rpc.mockImplementationOnce(() => old.promise)
    await act(async () => button('1 chat to check').click())
    host.state.failed = [failure('b')]
    rpc.mockImplementationOnce(() => newer.promise)
    await act(async () => emit(8, [source(8)]))
    await act(async () => {
      if (mode === 'unavailable') {
        newer.reject(new Error('newer unavailable'))
      } else {
        newer.resolve({ sessions: [], failed: host.state.failed })
      }
    })
    await act(async () => old.resolve({ sessions: [], failed: [] }))
    expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
    expect(getNativeChatRestartOffer().available).toBe(mode === 'failure')
    if (mode === 'failure') {
      expect(getNativeChatRestartOffer().failed).toHaveLength(1)
    } else {
      expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
      await act(async () => button('Done').click())
      expect(getNativeChatRestartRun()).not.toBeNull()
    }
  }
)
it('refreshes a genuinely later normal Send after pending Dismiss settles', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  visibleOwner()
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  rpc.mockImplementationOnce(async () => {
    throw new Error('reopen unavailable')
  })
  await act(async () => lastToastShow()?.())
  await act(async () => button('Need you1').click())
  await act(async () => refreshNativeChatRestartOffer())
  expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
  const dismiss = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce(() => dismiss.promise)
  await act(async () => button('Dismiss "Prompt b" in workspace').click())
  await act(async () => button('Close').click())
  noteStructuredAgentSessionFence('b', 2)
  const reply = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce((_target, method) => {
    expect(method).toBe('agentSession.send')
    return reply.promise
  })
  await act(async () => {
    const sent = sendStructuredAgentSessionMessage({
      sessionId: 'b',
      target: { kind: 'local' },
      text: 'later',
      callerKeepsText: true
    })
    if (!sent) {
      throw new Error('send not admitted')
    }
    reply.resolve({
      ok: true,
      replayed: false,
      fence: 2,
      cursor: { epoch: 'resume-b', sequence: 8 },
      value: {
        clientMessageId: sent.clientMessageId,
        submission: source(8, { clientMessageId: sent.clientMessageId })
      }
    })
    await sent.outcome
  })
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
  vi.useFakeTimers()
  await act(async () => {
    statusStream.emit({
      type: 'snapshot',
      sessions: [...statusStream.snapshot.values()].map((row) =>
        row.sessionId === 'b'
          ? { ...row, status: 'idle', turnOutcome: 'success', latestPrompt: 'later' }
          : row
      )
    })
    await vi.advanceTimersByTimeAsync(600)
  })
  vi.useRealTimers()
  const reads = rpc.mock.calls.filter(
    ([, method]) => method === 'agentSession.restartResumable'
  ).length
  host.state.failed = []
  await act(async () => dismiss.resolve({ sessions: [], failed: [] }))
  expect(
    rpc.mock.calls.filter(([, method]) => method === 'agentSession.restartResumable').length
  ).toBeGreaterThan(reads)
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeDefined()
  expect(button('2 chats resumed')).toBeDefined()
})
it('does not auto-resume from a superseded successful launch read', async () => {
  const old = Promise.withResolvers<unknown>()
  let reads = 0
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return reads++ === 0 ? old.promise : { sessions: [], failed: [] }
    }
    return { sessions: [], failed: [], continued: [] }
  })
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('missing settings')
  }
  useAppStore.setState({ settings: { ...settings, nativeChatResumeWorkOnRestart: true } })
  await surfaces()
  await act(async () => refreshNativeChatRestartOffer())
  await act(async () => old.resolve({ sessions: [failure('b')], failed: [] }))
  expect(
    rpc.mock.calls.filter(([, method]) => method === 'agentSession.restartContinue')
  ).toHaveLength(0)
  expect(getNativeChatRestartOffer().candidates).toEqual([])
})

it('rejects a read issued before a later Continue action begins', async () => {
  fakeHost()
  await surfaces()
  const old = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce(() => old.promise)
  const reading = refreshNativeChatRestartOffer()
  await act(async () => button('Resume 2 chats').click())
  await act(async () => {
    old.resolve({ sessions: [failure('b')], failed: [] })
    await reading
  })
  expect(getNativeChatRestartOffer().candidates).toEqual([])
  expect(getNativeChatRestartRun()?.continued).toHaveLength(2)
})
it('rejects a read issued during Dismiss after that action settles', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  const reply = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce(() => reply.promise)
  const dismissal = dismissNativeChatRestartOffer(['b'])
  const old = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce(() => old.promise)
  const reading = refreshNativeChatRestartOffer()
  host.state.failed = []
  await act(async () => {
    reply.resolve({ sessions: [], failed: [] })
    await dismissal
  })
  await act(async () => {
    old.resolve({ sessions: [], failed: [failure('b')] })
    await reading
  })
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(getNativeChatRestartOffer().available).toBe(true)
})

it('refreshes after acceptance and Dismiss replies arrive in the same response batch', async () => {
  const host = fakeHost({}, (id) => (id === 'a' ? 'continued' : 'unknown'))
  visibleOwner()
  await surfaces()
  await act(async () => button('Resume 2 chats').click())
  rpc.mockImplementationOnce(async () => {
    throw new Error('reopen unavailable')
  })
  await act(async () => lastToastShow()?.())
  await act(async () => button('Need you1').click())
  await act(async () => refreshNativeChatRestartOffer())
  const dismiss = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce(() => dismiss.promise)
  await act(async () => button('Dismiss "Prompt b" in workspace').click())
  await act(async () => button('Close').click())
  noteStructuredAgentSessionFence('b', 2)
  const reply = Promise.withResolvers<unknown>()
  rpc.mockImplementationOnce(() => reply.promise)
  const sending: { sent?: ReturnType<typeof sendStructuredAgentSessionMessage> } = {}
  await act(async () => {
    sending.sent = sendStructuredAgentSessionMessage({
      sessionId: 'b',
      target: { kind: 'local' },
      text: 'later',
      callerKeepsText: true
    })
  })
  const sent = sending.sent
  if (!sent) {
    throw new Error('send not admitted')
  }
  host.state.failed = []
  await act(async () => {
    reply.resolve({
      ok: true,
      replayed: false,
      fence: 2,
      cursor: { epoch: 'resume-b', sequence: 8 },
      value: {
        clientMessageId: sent.clientMessageId,
        submission: source(8, { clientMessageId: sent.clientMessageId })
      }
    })
    dismiss.resolve({ sessions: [], failed: [] })
    await sent.outcome
  })
  expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeDefined()
  expect(button('2 chats resumed')).toBeDefined()
})
