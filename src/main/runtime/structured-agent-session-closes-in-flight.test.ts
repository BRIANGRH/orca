import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  StructuredAgentSessionClosesInFlight,
  type StructuredAgentSessionPublication
} from './structured-agent-session-closes-in-flight'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('chat closes in flight', () => {
  it('cancels lazy targets only in restoration attempts present at close arrival', async () => {
    const closes = new StructuredAgentSessionClosesInFlight()
    const originalReady = deferred()
    const newerReady = deferred()
    const closeReady = deferred()
    const original = closes.runRestoration(async (attempt) => {
      await originalReady.promise
      return attempt.signalFor('s').aborted
    })
    const closing = closes.track('s', async (request) => {
      await closeReady.promise
      await closes.commit('s', async () => {}, request)
    })
    const newer = closes.runRestoration(async (attempt) => {
      await newerReady.promise
      return attempt.signalFor('s').aborted
    })
    closeReady.resolve()
    await closing
    originalReady.resolve()
    newerReady.resolve()
    expect(await original).toBe(true)
    expect(await newer).toBe(false)
  })

  it('releases a failed restoration participant rather than retaining future close authority', async () => {
    const closes = new StructuredAgentSessionClosesInFlight()
    const ended: StructuredAgentSessionPublication[] = []
    await expect(
      closes.runRestoration(async (attempt) => {
        ended.push(attempt)
        throw new Error('preparation failed')
      })
    ).rejects.toThrow('preparation failed')
    await closes.commit('s', async () => {})
    expect(ended[0]?.signalFor('s').aborted).toBe(false)
  })

  it('settles at once when nothing closes the session', async () => {
    await expect(new StructuredAgentSessionClosesInFlight().settled('s', 10)).resolves.toBe(true)
  })

  it('marks a close in flight from the call, before the close itself runs', async () => {
    const closes = new StructuredAgentSessionClosesInFlight()
    const gate = deferred()
    const close = vi.fn(() => gate.promise)
    const tracked = closes.track('s', close)
    expect(close).not.toHaveBeenCalled()
    let settled = false
    const waiting = closes.settled('s', 60_000).then((value) => {
      settled = value
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    gate.resolve()
    await tracked
    await waiting
    expect(settled).toBe(true)
  })

  it('waits for every overlapping close, a failed one included, and only of that session', async () => {
    const closes = new StructuredAgentSessionClosesInFlight()
    const first = deferred()
    const second = deferred()
    const other = deferred()
    void closes.track('s', () => first.promise)
    const failing = closes.track('s', () => second.promise)
    void closes.track('other', () => other.promise)
    let settled: boolean | null = null
    const waiting = closes.settled('s', 60_000).then((value) => {
      settled = value
    })
    first.resolve()
    await first.promise
    await Promise.resolve()
    expect(settled).toBeNull()
    second.reject(new Error('relay refused'))
    await expect(failing).rejects.toThrow('relay refused')
    await waiting
    expect(settled).toBe(true)
    other.resolve()
  })

  it('cancels only the concrete openings a committed close overtakes', async () => {
    const closes = new StructuredAgentSessionClosesInFlight()
    const request = deferred()
    const first = deferred()
    let earlierSignal: AbortSignal | undefined
    const opening = closes.runPublication('s', async (signal) => {
      earlierSignal = signal
      await first.promise
      return signal.aborted
    })
    // A close request that a later check may still refuse cancels nothing.
    const requested = closes.track('s', () => request.promise)
    expect(earlierSignal?.aborted).toBe(false)
    const gate = deferred()
    const committed = closes.commit('s', () => gate.promise)
    expect(earlierSignal?.aborted).toBe(true)
    gate.resolve()
    await committed
    expect(earlierSignal?.aborted).toBe(true)
    await expect(closes.runPublication('s', async (signal) => signal.aborted)).resolves.toBe(false)
    await expect(closes.runPublication('other', async (signal) => signal.aborted)).resolves.toBe(
      false
    )
    first.resolve()
    await expect(opening).resolves.toBe(true)
    request.resolve()
    await requested
  })

  it('answers false once a close outlives the bound, and forgets the close when it ends', async () => {
    vi.useFakeTimers()
    const closes = new StructuredAgentSessionClosesInFlight()
    const gate = deferred()
    const tracked = closes.track('s', () => gate.promise)
    const waiting = closes.settled('s', 10_000)
    await vi.advanceTimersByTimeAsync(9_999)
    let early: boolean | null = null
    void waiting.then((value) => {
      early = value
    })
    await Promise.resolve()
    expect(early).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toBe(false)
    gate.resolve()
    await tracked
    await expect(closes.settled('s', 1)).resolves.toBe(true)
  })
})
