// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import {
  createResumeModalFixture,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import {
  getNativeChatRestartRun,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'
import {
  sendStructuredAgentSessionMessage,
  resetStructuredAgentSessionSendsForTests
} from './native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './native-chat/structured-agent-session-send-attempt'
import { resetStructuredAgentSessionReadOwnersForTests } from './native-chat/structured-agent-session-read-owner'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({ emit: () => {}, snapshot: new Map() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSession: async () => ({ unsubscribe: () => {} }),
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
afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
})

it.each(['pending success', 'completed success', 'pending failure'] as const)(
  'replaces an invalidated source read at settlement: %s',
  async (mode) => {
    const host = fakeHost({}, () => 'unknown')
    host.hold('a', 'b')
    await mount(
      <>
        <NativeChatResumeOnRestartModal />
        <NativeChatResumeStatusSegment iconOnly={false} />
      </>
    )
    await act(async () => button('Resume 2 chats').click())
    await host.release('a', 'b')
    expect(getNativeChatRestartRun()?.finishedViewShown).toBeUndefined()
    const sendReply = Promise.withResolvers<unknown>()
    const oldRead = Promise.withResolvers<unknown>()
    const dismissReply = Promise.withResolvers<unknown>()
    const replacement = Promise.withResolvers<unknown>()
    const base = rpc.getMockImplementation()
    if (!base) {
      throw new Error('missing host implementation')
    }
    let oldIssued = false
    let failReconciliation = false
    let replacementExpected = false
    let replacementIssued = false
    rpc.mockImplementation((target, method, params) => {
      if (method === 'agentSession.send') {
        return sendReply.promise
      }
      if (method === 'agentSession.restartResumableDismiss') {
        return dismissReply.promise
      }
      if (method === 'agentSession.restartResumable' && failReconciliation) {
        failReconciliation = false
        return Promise.reject(new Error('immediate reconciliation unavailable'))
      }
      if (method === 'agentSession.restartResumable' && replacementExpected && !replacementIssued) {
        replacementIssued = true
        return replacement.promise
      }
      if (
        method === 'agentSession.restartResumable' &&
        getNativeChatRestartRun()?.entries[1]?.userRequest &&
        !oldIssued
      ) {
        oldIssued = true
        return oldRead.promise
      }
      return base(target, method, params)
    })
    noteStructuredAgentSessionFence('b', 2)
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
      throw new Error('normal Send not admitted')
    }
    await act(async () => button('2 chats to check').click())
    vi.useFakeTimers()
    await act(async () => {
      statusStream.emit({
        type: 'snapshot',
        sessions: [...statusStream.snapshot.values()].map((row) =>
          row.sessionId === 'b'
            ? {
                ...row,
                status: 'idle',
                latestPrompt: 'later',
                turnOutcome: 'success',
                updatedAt: Date.now()
              }
            : row
        )
      })
      await vi.advanceTimersByTimeAsync(600)
    })
    vi.useRealTimers()
    host.state.failed = host.state.failed.filter((row) => row.sessionId !== 'b')
    await act(async () => {
      sendReply.resolve({
        ok: true,
        replayed: false,
        fence: 2,
        cursor: { epoch: 'resume-b', sequence: 8 },
        value: {
          clientMessageId: sent.clientMessageId,
          submission: {
            clientMessageId: sent.clientMessageId,
            fence: 2,
            payloadFingerprint: 'fp',
            dispatchState: 'accepted',
            providerItemId: 'provider-8',
            reason: null,
            submittedAt: 1,
            resolvedAt: 2,
            submittedSequence: 8,
            origin: 'client',
            source: { kind: 'user' }
          }
        }
      })
      await sent.outcome
    })
    expect(oldIssued).toBe(true)
    const witness = getNativeChatRestartRun()?.entries[1]?.userRequest?.submission
    await act(async () => button('Dismiss "Prompt a" in workspace').click())
    if (mode === 'completed success') {
      await act(async () => oldRead.resolve({ sessions: [], failed: host.state.failed }))
    }
    failReconciliation = true
    replacementExpected = true
    await act(async () => dismissReply.reject(new Error('lost Dismiss reply')))
    expect(getNativeChatRestartOffer().available).toBe(false)
    expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.submission).toBe(witness)
    expect(replacementIssued).toBe(true)
    const reads = rpc.mock.calls.filter(
      ([, method]) => method === 'agentSession.restartResumable'
    ).length
    await act(async () => oldRead.resolve({ sessions: [], failed: host.state.failed }))
    expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
    expect(
      rpc.mock.calls.filter(([, method]) => method === 'agentSession.restartResumable')
    ).toHaveLength(reads)
    await act(async () => {
      if (mode === 'pending failure') {
        replacement.reject(new Error('current replacement unavailable'))
      } else {
        replacement.resolve({ sessions: [], failed: host.state.failed })
      }
    })
    if (mode === 'pending failure') {
      expect(getNativeChatRestartOffer().available).toBe(false)
      expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeUndefined()
      expect(runStatus('Prompt b')).not.toBe('Prompt b: Resumed by you')
      await act(async () => refreshNativeChatRestartOffer())
    }
    expect(runStatus('Prompt b')).toBe('Prompt b: Resumed by you')
    expect(getNativeChatRestartRun()?.entries[1]?.userRequest?.offer).toBeDefined()
  }
)
