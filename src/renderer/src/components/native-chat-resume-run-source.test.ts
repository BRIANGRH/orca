import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  getStructuredAgentSessionReadOwner,
  retireStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './native-chat/structured-agent-session-read-owner'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { beginResumeRun, type ResumeRun } from './native-chat-resume-run'
import { resumeRunView } from './native-chat-resume-run-view'
import { watchResumeRunSource } from './native-chat-resume-run-source'
import { readResumeRunSourceCursor } from './native-chat-resume-run-source-cursor'
import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'
import { failure } from './native-chat-resume-modal.test-support'

const rpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<AgentSessionHistoryResult>>())
const wire = vi.hoisted(() => ({
  emit: (_event: AgentSessionSubscribeEvent) => {},
  unsubscribe: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSession: async (
    _target: unknown,
    _params: unknown,
    emit: typeof wire.emit
  ) => {
    wire.emit = emit
    return { unsubscribe: wire.unsubscribe }
  },
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
const LOCAL = { kind: 'local' } as const
const resources: (() => void)[] = []
beforeEach(() => {
  rpc.mockReset()
  wire.unsubscribe.mockReset()
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
})
afterEach(() => {
  resources.splice(0).forEach((release) => release())
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.useRealTimers()
})
function submission(
  sequence: number,
  changes: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: `user-${sequence}`,
    fence: 2,
    payloadFingerprint: 'payload',
    dispatchState: 'accepted',
    providerItemId: `provider-${sequence}`,
    reason: null,
    submittedAt: Number.MAX_SAFE_INTEGER,
    resolvedAt: Number.MAX_SAFE_INTEGER,
    submittedSequence: sequence,
    origin: 'client',
    source: { kind: 'user' },
    ...changes
  }
}
function page(sequence: number, records: AgentJournalSubmission[] = []): AgentSessionHistoryPage {
  const cursor = { epoch: 'epoch-b', sequence }
  return {
    sessionId: 'b',
    epoch: cursor.epoch,
    direction: 'tail',
    fence: 2,
    items: [],
    submissions: records,
    removedItemIds: [],
    hasOlder: false,
    hasNewer: false,
    liveCursor: cursor,
    window: { oldest: null, newest: null, nextCursor: cursor }
  }
}
function publishPage(sequence: number, records: AgentJournalSubmission[]): void {
  retireStructuredAgentSessionReadOwner('b', LOCAL)
  getStructuredAgentSessionReadOwner('b', LOCAL).publishCreated(page(sequence, records))
}
function fixture(cursor?: number) {
  let run: ResumeRun = {
    ...beginResumeRun([failure('b')], 100, 'user'),
    inFlight: false,
    continued: [{ sessionId: 'b', outcome: 'unknown' }],
    entries: [
      {
        candidate: failure('b'),
        ...(cursor === undefined ? {} : { sourceCursor: { epoch: 'epoch-b', sequence: cursor } })
      }
    ]
  }
  let offer: NativeChatRestartOffer = {
    available: true,
    candidates: [],
    failed: [failure('b')],
    listedAt: 100
  }
  const publish = vi.fn((next: ResumeRun) => {
    run = next
  })
  let watch: ReturnType<typeof watchResumeRunSource> | undefined
  const refresh = vi.fn(async () => watch?.offerChanged())
  watch = watchResumeRunSource({ current: () => run, publish, offer: () => offer, refresh })
  resources.push(watch.release)
  return {
    run: () => run,
    publish,
    refresh,
    release: watch.release,
    withdraw: () => {
      offer = { ...offer, failed: [], listedAt: 200 }
      watch?.offerChanged()
    },
    view: () =>
      resumeRunView(
        run,
        [],
        () => undefined,
        'all',
        undefined,
        true,
        () => 'open'
      )
  }
}
it('ignores future-dated old accepted data when the first checkpoint arrives', async () => {
  const pending = Promise.withResolvers<AgentSessionHistoryResult>()
  rpc.mockReturnValueOnce(pending.promise)
  const test = fixture()
  publishPage(7, [submission(5)])
  pending.resolve({ ok: true, page: page(7) })
  await vi.waitFor(() => expect(test.run().entries[0]?.sourceCursor?.sequence).toBe(7))
  test.withdraw()
  expect(test.view().counts.resumed).toBe(0)
  expect(test.view().counts.attention).toBe(1)
  publishPage(8, [submission(8)])
  await vi.waitFor(() =>
    expect(test.run().entries[0]?.userRequest?.submission.clientMessageId).toBe('user-8')
  )
  test.withdraw()
  expect(test.view().counts.resumed).toBe(1)
})
it('keeps a request racing first hydration unknown until a later identifiable request', async () => {
  const pending = Promise.withResolvers<AgentSessionHistoryResult>()
  rpc.mockReturnValueOnce(pending.promise)
  const test = fixture()
  publishPage(8, [submission(8)])
  pending.resolve({ ok: true, page: page(8) })
  await vi.waitFor(() => expect(test.run().entries[0]?.sourceCursor?.sequence).toBe(8))
  test.withdraw()
  expect(test.view().counts.resumed).toBe(0)
  publishPage(9, [submission(9)])
  await vi.waitFor(() =>
    expect(test.run().entries[0]?.userRequest?.submission.clientMessageId).toBe('user-9')
  )
  test.withdraw()
  expect(test.view().counts.resumed).toBe(1)
})
it.each(['host', 'missing source', 'missing sequence', 'different epoch'] as const)(
  'does not credit %s evidence as a later user resume',
  async (kind) => {
    const test = fixture(7)
    const record = submission(
      8,
      kind === 'host'
        ? { origin: 'host', source: undefined }
        : kind === 'missing source'
          ? { source: undefined }
          : kind === 'missing sequence'
            ? { submittedSequence: undefined }
            : {}
    )
    const history = page(8, [record])
    if (kind === 'different epoch') {
      history.epoch = 'different'
      history.liveCursor = { epoch: 'different', sequence: 8 }
      history.window.nextCursor = history.liveCursor
    }
    getStructuredAgentSessionReadOwner('b', LOCAL).publishCreated(history)
    test.withdraw()
    expect(test.view().counts.resumed).toBe(0)
  }
)
it('does not hydrate still-listed rows or activate an already active reader again', async () => {
  const owner = getStructuredAgentSessionReadOwner('b', LOCAL)
  owner.publishCreated(page(0))
  const activate = vi.spyOn(owner, 'activate')
  resources.push(owner.activate())
  await Promise.resolve()
  const test = fixture(0)
  expect(rpc).not.toHaveBeenCalled()
  expect(activate).toHaveBeenCalledTimes(1)
  vi.useFakeTimers()
  wire.emit({
    type: 'batch',
    sessionId: 'b',
    fence: 2,
    batch: {
      cursor: { epoch: 'epoch-b', sequence: 1 },
      items: [
        {
          itemId: 'assistant',
          sequence: 1,
          revision: 0,
          observedAt: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'prose' }] }
        }
      ],
      submissions: [],
      removedItemIds: []
    }
  })
  await vi.advanceTimersByTimeAsync(50)
  expect(test.publish).not.toHaveBeenCalled()
  expect(test.refresh).not.toHaveBeenCalled()
  expect(activate).toHaveBeenCalledTimes(1)
  test.release()
  expect(activate).toHaveBeenCalledTimes(1)
})
it('releases a disposed result before its delayed checkpoint can publish', async () => {
  const pending = Promise.withResolvers<AgentSessionHistoryResult>()
  rpc.mockReturnValueOnce(pending.promise)
  const test = fixture()
  test.release()
  pending.resolve({ ok: true, page: page(7) })
  await Promise.resolve()
  await Promise.resolve()
  expect(test.publish).not.toHaveBeenCalled()
  expect(test.run().entries[0]?.sourceCursor).toBeUndefined()
})

it('does not treat a legacy backward page cursor as a current source checkpoint', async () => {
  const history = page(7)
  history.liveCursor = undefined
  rpc.mockResolvedValueOnce({ ok: true, page: history })
  expect(await readResumeRunSourceCursor('b')).toBeUndefined()
  expect(rpc).toHaveBeenCalledWith(LOCAL, 'agentSession.history', {
    sessionId: 'b',
    direction: 'tail',
    limit: 1
  })
})

it('keeps one admitted reader through pending acceptance and releases it after confirmation', async () => {
  const owner = getStructuredAgentSessionReadOwner('b', LOCAL)
  owner.publishCreated(page(7))
  const activate = vi.spyOn(owner, 'activate')
  const test = fixture(7)
  test.withdraw()
  await Promise.resolve()
  expect(activate).toHaveBeenCalledTimes(1)
  expect(owner.hasActiveReaders()).toBe(true)
  wire.emit({
    type: 'snapshot',
    sessionId: 'b',
    fence: 2,
    page: page(8, [submission(8, { dispatchState: 'pending', providerItemId: null })])
  })
  expect(owner.hasActiveReaders()).toBe(true)
  expect(test.refresh).not.toHaveBeenCalled()
  wire.emit({ type: 'snapshot', sessionId: 'b', fence: 2, page: page(9, [submission(8)]) })
  await vi.waitFor(() => expect(test.view().counts.resumed).toBe(1))
  expect(owner.hasActiveReaders()).toBe(false)
  expect(wire.unsubscribe).toHaveBeenCalledTimes(1)
  expect(activate).toHaveBeenCalledTimes(1)
  test.release()
  expect(wire.unsubscribe).toHaveBeenCalledTimes(1)
})

it('does not repeat an admitted read for unchanged withdrawal snapshots', async () => {
  const owner = getStructuredAgentSessionReadOwner('b', LOCAL)
  owner.publishCreated(page(7))
  const activate = vi.spyOn(owner, 'activate')
  const test = fixture(7)
  test.withdraw()
  await Promise.resolve()
  wire.emit({ type: 'snapshot', sessionId: 'b', fence: 2, page: page(8) })
  expect(owner.hasActiveReaders()).toBe(false)
  test.withdraw()
  expect(activate).toHaveBeenCalledTimes(1)
  expect(rpc).not.toHaveBeenCalled()
  expect(test.view().counts.resumed).toBe(0)
})
