import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createResumeOfferRead,
  readLaunchResumeOffer,
  type HostOfferPayload
} from './native-chat-resume-offer-read'
const rpc = vi.hoisted(() => vi.fn<() => Promise<HostOfferPayload>>())
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: rpc }))
beforeEach(() => rpc.mockReset())
afterEach(() => vi.useRealTimers())
function fixture() {
  const answer = vi.fn()
  const unavailable = vi.fn()
  return {
    answer,
    unavailable,
    read: createResumeOfferRead(
      { kind: 'local' },
      () => ({ current: () => true, answer }),
      unavailable
    )
  }
}
it.each(['success', 'failure'] as const)(
  'discards older successful rows after the newer read reports %s',
  async (mode) => {
    const old = Promise.withResolvers<HostOfferPayload>()
    const newer = Promise.withResolvers<HostOfferPayload>()
    rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const test = fixture()
    const first = test.read()
    const second = test.read()
    if (mode === 'success') {
      newer.resolve({ sessions: [], failed: [] })
    } else {
      newer.reject(new Error('unavailable'))
    }
    await second
    old.resolve({
      sessions: [
        {
          sessionId: 'old',
          workspaceId: 'workspace',
          agent: 'codex',
          trigger: 'quit',
          latestPrompt: 'old',
          recordedAt: 1
        }
      ],
      failed: []
    })
    expect(await first).toBeUndefined()
    expect(test.answer).toHaveBeenCalledTimes(mode === 'success' ? 1 : 0)
    expect(test.unavailable).toHaveBeenCalledTimes(mode === 'failure' ? 1 : 0)
  }
)
it('does not let an older failure replace a newer confirmed answer', async () => {
  const old = Promise.withResolvers<HostOfferPayload>()
  rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sessions: [], failed: [] })
  const test = fixture()
  const first = test.read()
  await test.read()
  old.reject(new Error('old failure'))
  expect(await first).toBeUndefined()
  expect(test.answer).toHaveBeenCalledTimes(1)
  expect(test.unavailable).not.toHaveBeenCalled()
})

it('discards a response when its publication subscriber starts a newer read', async () => {
  rpc.mockResolvedValue({ sessions: [], failed: [] })
  const test = fixture()
  const next: { read?: ReturnType<typeof test.read> } = {}
  test.answer.mockImplementationOnce(() => {
    next.read = test.read()
  })
  expect(await test.read()).toBeUndefined()
  await next.read
  expect(test.answer).toHaveBeenCalledTimes(2)
})
it('stops a superseded launch decision without another retry', async () => {
  const read = vi.fn().mockResolvedValue(undefined)
  expect(await readLaunchResumeOffer(read)).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(1)
})
it('keeps finite startup retries and stops on a confirmed empty answer', async () => {
  vi.useFakeTimers()
  const read = vi
    .fn()
    .mockResolvedValueOnce({ available: false, candidates: [], failed: [] })
    .mockResolvedValue({ available: true, candidates: [], failed: [] })
  const loading = readLaunchResumeOffer(read)
  await vi.advanceTimersByTimeAsync(100)
  expect(await loading).toEqual({ available: true, candidates: [], failed: [] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(read).toHaveBeenCalledTimes(2)
})
