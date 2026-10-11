import { afterEach, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionClosesInFlight } from './structured-agent-session-closes-in-flight'

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

  it('reports a close in flight from the call until it settles, per session', async () => {
    const closes = new StructuredAgentSessionClosesInFlight()
    const gate = deferred()
    const tracked = closes.track('s', () => gate.promise)
    expect(closes.has('s')).toBe(true)
    expect(closes.has('other')).toBe(false)
    gate.resolve()
    await tracked
    await Promise.resolve()
    expect(closes.has('s')).toBe(false)
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
