/**
 * The chat closes a host is still running, per session id, in memory only.
 *
 * A reveal of the same chat waits for them, so a reopen is never retired by its own earlier close.
 * Each entry ends in its close's `finally`, so nothing here can outlive the work it names.
 */
export class StructuredAgentSessionClosesInFlight {
  private readonly bySession = new Map<string, Set<Promise<unknown>>>()

  /** Runs one close, marked in flight from this call until it settles. */
  track<T>(sessionId: string, close: () => Promise<T>): Promise<T> {
    const closes = this.bySession.get(sessionId) ?? new Set<Promise<unknown>>()
    this.bySession.set(sessionId, closes)
    // Marked before the close starts, so a reveal arriving during its first await already waits.
    const run = Promise.resolve().then(close)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    closes.add(settled)
    void settled.finally(() => {
      closes.delete(settled)
      if (closes.size === 0 && this.bySession.get(sessionId) === closes) {
        this.bySession.delete(sessionId)
      }
    })
    return run
  }

  /** True once no close of the session is running; false if one still is after `timeoutMs`. */
  async settled(sessionId: string, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs)
    })
    try {
      // A close that begins while an earlier one settles is waited for too, within the same bound.
      for (let closes = this.bySession.get(sessionId); closes;) {
        if ((await Promise.race([Promise.all(closes), expired])) === 'expired') {
          return false
        }
        closes = this.bySession.get(sessionId)
      }
      return true
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Keyed by runtime identity alone, so each runtime (and each test's) has its own. */
const registries = new WeakMap<WeakKey, StructuredAgentSessionClosesInFlight>()

export function getStructuredAgentSessionClosesInFlight(
  runtime: WeakKey
): StructuredAgentSessionClosesInFlight {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new StructuredAgentSessionClosesInFlight()
    registries.set(runtime, registry)
  }
  return registry
}
