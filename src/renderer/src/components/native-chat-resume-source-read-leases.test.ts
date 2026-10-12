import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './native-chat/structured-agent-session-read-owner'
import {
  createResumeSourceReadLeases,
  RESUME_RUN_SOURCE_READ_BUDGET_MS
} from './native-chat-resume-source-read-leases'
const subscribe = vi.hoisted(() => vi.fn(async () => ({ unsubscribe: () => {} })))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSession: subscribe,
  callStructuredAgentSession: vi.fn()
}))
const LOCAL = { kind: 'local' } as const
const releases: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  subscribe.mockClear()
  resetStructuredAgentSessionReadOwnersForTests()
})
afterEach(() => {
  releases.splice(0).forEach((release) => release())
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
})
function owners() {
  return new Map(
    Array.from({ length: 12 }, (_, index) => {
      const id = `chat-${index}`
      const owner = getStructuredAgentSessionReadOwner(id, LOCAL)
      const cursor = { epoch: `epoch-${id}`, sequence: 7 }
      owner.publishCreated({
        sessionId: id,
        epoch: cursor.epoch,
        direction: 'tail',
        fence: 1,
        items: [],
        submissions: [],
        removedItemIds: [],
        hasOlder: false,
        hasNewer: false,
        liveCursor: cursor,
        window: { oldest: null, newest: null, nextCursor: cursor }
      })
      return [id, owner] as const
    })
  )
}
it('observes every admitted chat with at most four owned active readers', async () => {
  const chats = owners()
  const leases = createResumeSourceReadLeases({ prepare: (id) => chats.get(id), expired: () => {} })
  releases.push(leases.dispose)
  for (const id of chats.keys()) {
    leases.admit(id)
  }
  expect([...chats.values()].filter((owner) => owner.hasActiveReaders())).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS + 1)
  expect([...chats.values()].filter((owner) => owner.hasActiveReaders())).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS + 1)
  expect([...chats.values()].filter((owner) => owner.hasActiveReaders())).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS + 1)
  expect([...chats.values()].some((owner) => owner.hasActiveReaders())).toBe(false)
  expect(subscribe).toHaveBeenCalledTimes(12)
})
it('disposes owned and queued reads while leaving a visible owner active', async () => {
  const chats = owners()
  const visible = chats.get('chat-0')
  if (!visible) {
    throw new Error('missing visible reader')
  }
  releases.push(visible.activate())
  const prepare = vi.fn((id: string) => chats.get(id))
  const leases = createResumeSourceReadLeases({ prepare, expired: () => {} })
  for (const id of chats.keys()) {
    leases.admit(id)
  }
  expect([...chats.values()].filter((owner) => owner.hasActiveReaders())).toHaveLength(5)
  expect(leases.has('chat-0')).toBe(false)
  leases.dispose()
  const observed = prepare.mock.calls.length
  await vi.advanceTimersByTimeAsync(RESUME_RUN_SOURCE_READ_BUDGET_MS * 4)
  expect(prepare).toHaveBeenCalledTimes(observed)
  expect([...chats.values()].filter((owner) => owner.hasActiveReaders())).toEqual([visible])
})
