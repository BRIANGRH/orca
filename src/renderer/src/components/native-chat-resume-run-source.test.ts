import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
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
import {
  watchResumeRunSource,
  RESUME_RUN_SOURCE_READ_BUDGET_MS
} from './native-chat-resume-run-source'
import { admitUserResumeRequest } from './native-chat-resume-user-action.test-support'
import { createResumeOfferRead, type ResumeOfferReadRequest } from './native-chat-resume-offer-read'
import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'
import { failure } from './native-chat-resume-modal.test-support'

const rpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const wire = vi.hoisted(() => ({
  emit: (_event: AgentSessionSubscribeEvent) => {},
  unsubscribe: vi.fn(),
  failing: false,
  attempts: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSession: async (
    _target: unknown,
    _params: unknown,
    emit: typeof wire.emit
  ) => {
    wire.attempts()
    if (wire.failing) {
      throw new Error('ECONNRESET')
    }
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
  wire.attempts.mockReset()
  wire.failing = false
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
function fixture(cursor?: number, read?: () => ResumeOfferReadRequest) {
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
  const refresh = vi.fn(() =>
    read
      ? read()
      : {
          current: () => true,
          result: Promise.resolve().then(() => {
            watch?.offerChanged(run)
            return undefined
          })
        }
  )
  watch = watchResumeRunSource({ current: () => run, publish, offer: () => offer, refresh })
  resources.push(watch.release)
  return {
    run: () => run,
    publish,
    refresh,
    release: watch.release,
    settled: watch.settled,
    withdraw: () => {
      offer = { ...offer, failed: [], listedAt: 200 }
      watch?.offerChanged(run)
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
it('keeps unread old history unknown instead of inventing a post-action boundary', () => {
  const test = fixture()
  publishPage(7, [submission(5)])
  test.withdraw()
  expect(test.view().counts.resumed).toBe(0)
  expect(rpc).not.toHaveBeenCalled()
})
it('credits the first locally admitted send even when it races first hydration', async () => {
  const test = fixture()
  admitUserResumeRequest('b', 'user-8')
  publishPage(8, [submission(8)])
  await vi.waitFor(() =>
    expect(test.run().entries[0]?.userRequest?.submission.clientMessageId).toBe('user-8')
  )
  test.withdraw()
  expect(test.view().counts.resumed).toBe(1)
  expect(rpc).not.toHaveBeenCalled()
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
it('ignores user admissions and reader arrivals after disposal', () => {
  const test = fixture()
  test.release()
  admitUserResumeRequest('b', 'user-8')
  publishPage(8, [submission(8)])
  expect(test.publish).not.toHaveBeenCalled()
  expect(test.run().entries[0]?.userRequest).toBeUndefined()
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

it('expires an owned read despite retained ready content and ordinary contact retries', async () => {
  vi.useFakeTimers()
  const owner = getStructuredAgentSessionReadOwner('b', LOCAL)
  owner.publishCreated(page(7))
  const test = fixture(7)
  wire.failing = true
  test.withdraw()
  await vi.advanceTimersByTimeAsync(900)
  expect(owner.getSnapshot().state.status).toBe('ready')
  expect(owner.hasActiveReaders()).toBe(true)
  expect(wire.attempts).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS)
  expect(owner.hasActiveReaders()).toBe(false)
  const attempts = wire.attempts.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(wire.attempts).toHaveBeenCalledTimes(attempts)
  expect(test.view().counts.resumed).toBe(0)
})
it('expires a forever-pending owned read without inventing recovery', async () => {
  vi.useFakeTimers()
  const owner = getStructuredAgentSessionReadOwner('b', LOCAL)
  owner.publishCreated(page(7))
  const test = fixture(7)
  test.withdraw()
  await Promise.resolve()
  wire.emit({
    type: 'snapshot',
    sessionId: 'b',
    fence: 2,
    page: page(8, [submission(8, { dispatchState: 'pending', providerItemId: null })])
  })
  expect(owner.hasActiveReaders()).toBe(true)
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS + 1)
  expect(owner.hasActiveReaders()).toBe(false)
  expect(test.view().counts.resumed).toBe(0)
})
it('keeps visible reader retries when the result has no activation to expire', async () => {
  vi.useFakeTimers()
  const owner = getStructuredAgentSessionReadOwner('b', LOCAL)
  owner.publishCreated(page(7))
  wire.failing = true
  resources.push(owner.activate())
  const test = fixture(7)
  test.withdraw()
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS + 1)
  expect(owner.hasActiveReaders()).toBe(true)
  const attempts = wire.attempts.mock.calls.length
  await vi.advanceTimersByTimeAsync(30_001)
  expect(wire.attempts.mock.calls.length).toBeGreaterThan(attempts)
  test.release()
  expect(owner.hasActiveReaders()).toBe(true)
})

it('keeps a replacement in its own slot when the obsolete read completes', async () => {
  const responses = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
  rpc
    .mockImplementationOnce(() => responses[0]!.promise)
    .mockImplementationOnce(() => responses[1]!.promise)
  let boundary = 0
  let test: ReturnType<typeof fixture>
  const requests: ResumeOfferReadRequest[] = []
  const start = createResumeOfferRead(
    LOCAL,
    () => {
      const issued = boundary
      return { current: () => boundary === issued, answer: () => test.withdraw() }
    },
    () => {}
  )
  test = fixture(7, () => {
    const request = start()
    requests.push(request)
    return request
  })
  admitUserResumeRequest('b', 'user-8')
  publishPage(8, [submission(8)])
  expect(rpc).toHaveBeenCalledTimes(1)
  boundary += 1
  test.settled()
  expect(rpc).toHaveBeenCalledTimes(2)
  responses[0]!.resolve({ sessions: [], failed: [] })
  await requests[0]?.result
  test.settled()
  expect(rpc).toHaveBeenCalledTimes(2)
  responses[1]!.resolve({ sessions: [], failed: [] })
  await requests[1]?.result
  expect(test.view().counts.resumed).toBe(1)
})
it('can replace a forever-pending invalid read and ignores late work after disposal', async () => {
  const responses = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
  rpc
    .mockImplementationOnce(() => responses[0]!.promise)
    .mockImplementationOnce(() => responses[1]!.promise)
  let boundary = 0
  let test: ReturnType<typeof fixture>
  const requests: ResumeOfferReadRequest[] = []
  const start = createResumeOfferRead(
    LOCAL,
    () => {
      const issued = boundary
      return { current: () => boundary === issued, answer: () => test.withdraw() }
    },
    () => {}
  )
  test = fixture(7, () => {
    const request = start()
    requests.push(request)
    return request
  })
  admitUserResumeRequest('b', 'user-8')
  publishPage(8, [submission(8)])
  boundary += 1
  test.settled()
  expect(rpc).toHaveBeenCalledTimes(2)
  test.release()
  const published = test.publish.mock.calls.length
  responses[1]!.resolve({ sessions: [], failed: [] })
  await requests[1]?.result
  responses[0]!.resolve({ sessions: [], failed: [] })
  await requests[0]?.result
  expect(test.publish).toHaveBeenCalledTimes(published)
  expect(rpc).toHaveBeenCalledTimes(2)
})
