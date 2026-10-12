// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  subscribeStructuredSessionUserActions,
  type StructuredSessionUserActionObservation
} from './structured-agent-session-user-actions'
import {
  sendStructuredAgentSessionMessage,
  reserveStructuredAgentSessionSend,
  resetStructuredAgentSessionSendsForTests
} from './structured-agent-session-message-sender'
import { structuredAgentSessionSendsWatched } from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: rpc }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const LOCAL = { kind: 'local' } as const
let events: StructuredSessionUserActionObservation[]
let release: () => void
function receipt(
  clientMessageId: string,
  changes: Partial<AgentJournalSubmission> = {}
): AgentSessionMutationResult<AgentSessionSendResult> {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-b', sequence: 8 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fp',
        dispatchState: 'accepted',
        providerItemId: 'provider',
        reason: null,
        submittedAt: 1,
        resolvedAt: 2,
        submittedSequence: 8,
        source: { kind: 'user' },
        origin: 'client',
        ...changes
      }
    }
  }
}
beforeEach(() => {
  rpc.mockReset()
  events = []
  release = subscribeStructuredSessionUserActions((event) => events.push(event))
  noteStructuredAgentSessionFence('b', 1)
})
afterEach(() => {
  release()
  resetStructuredAgentSessionSendsForTests()
  vi.restoreAllMocks()
})
it('captures allocation before dispatch and acceptance without impersonating a mounted view', async () => {
  rpc.mockImplementation(async (_target, _method, params) =>
    receipt(params.envelope.clientOperationId)
  )
  const sent = sendStructuredAgentSessionMessage({
    sessionId: 'b',
    target: LOCAL,
    text: 'same text',
    callerKeepsText: true
  })
  expect(sent).not.toBeNull()
  expect(events.map((event) => event.kind)).toEqual(['admitted', 'issued'])
  expect(structuredAgentSessionSendsWatched('b')).toBe(false)
  await expect(sent?.outcome).resolves.toBe('recorded')
  expect(events.map((event) => event.kind)).toEqual(['admitted', 'issued', 'accepted'])
  expect(events.at(-1)).toMatchObject({
    epoch: 'epoch-b',
    action: { clientMessageId: sent?.clientMessageId, target: LOCAL },
    submission: { clientMessageId: sent?.clientMessageId, dispatchState: 'accepted' }
  })
})
it('does not turn an earlier reservation into another admission when it later dispatches', async () => {
  rpc.mockImplementation(async (_target, _method, params) =>
    receipt(params.envelope.clientOperationId)
  )
  const reserved = reserveStructuredAgentSessionSend({
    sessionId: 'b',
    text: 'reserved',
    callerKeepsText: true
  })
  expect(reserved).not.toBeNull()
  expect(events.map((event) => event.kind)).toEqual(['admitted'])
  const beforeDismiss = events[0]?.action.clientMessageId
  const sent = reserved?.send(LOCAL)
  await expect(sent?.outcome).resolves.toBe('recorded')
  expect(events.filter((event) => event.kind === 'admitted')).toHaveLength(1)
  expect(sent?.clientMessageId).toBe(beforeDismiss)
})
it.each(['new card', 'already dispatched'] as const)(
  'records explicit %s Send through the production mutation seam',
  async (mode) => {
    rpc.mockImplementation(async (_target, method, params) => {
      expect(method).toBe('agentSession.queuedMessageSend')
      return receipt(mode === 'new card' ? params.envelope.clientOperationId : 'older-operation', {
        source: undefined,
        queuedMessageId: 'kept-message'
      })
    })
    const hook = renderHook(() =>
      useStructuredAgentSessionMutate({
        sessionId: 'b',
        target: LOCAL,
        stateRef: { current: { fence: 1 } }
      })
    )
    await act(async () => {
      await hook.result.current.mutate<AgentSessionSendResult>(
        'agentSession.queuedMessageSend',
        'agentSession.queuedMessageSend',
        { messageId: 'kept-message' }
      )
    })
    expect(events[0]).toMatchObject({
      kind: 'admitted',
      action: { kind: 'card-send', target: LOCAL }
    })
    expect(events.filter((event) => event.kind === 'accepted')).toHaveLength(
      mode === 'new card' ? 1 : 0
    )
    hook.unmount()
  }
)
it('lets the actual send settle when an observer throws', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const stopBadObserver = subscribeStructuredSessionUserActions(() => {
    throw new Error('observer failed')
  })
  try {
    rpc.mockImplementation(async (_target, _method, params) =>
      receipt(params.envelope.clientOperationId)
    )
    const sent = sendStructuredAgentSessionMessage({
      sessionId: 'b',
      target: LOCAL,
      text: 'send',
      callerKeepsText: true
    })
    await expect(sent?.outcome).resolves.toBe('recorded')
    expect(warn).toHaveBeenCalledTimes(3)
  } finally {
    stopBadObserver()
  }
})
