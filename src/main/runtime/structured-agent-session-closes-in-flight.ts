/**
 * The chat closes a host is still running, per session id, in memory only.
 *
 * A reopen waits for earlier closes; a committed close cancels the opening attempts it overtakes.
 * Entries end with their work, and cancellation belongs only to those concrete attempts.
 */
import { AgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { AGENT_SESSION_NOT_ATTACHED } from '../native-chat/agent-session-wire/structured-agent-session-mutation-refusals'

export const STRUCTURED_AGENT_SESSION_CLOSE_WAIT_MS = 3_000

export type StructuredAgentSessionCloseRequest = {
  cancelEarlierPublications: () => void
}

export class StructuredAgentSessionClosesInFlight {
  private readonly bySession = new Map<string, Set<Promise<unknown>>>()
  private readonly publications = new Map<string, Set<AbortController>>()

  /** Registered before preparation; a completed close cannot make this attempt current again. */
  async runPublication<T>(
    sessionId: string,
    publish: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return this.runPublications([sessionId], (signals) => publish(signals.get(sessionId)!))
  }

  /** A startup restore owns one concrete publication attempt for each of its original targets. */
  async runPublications<T>(
    sessionIds: readonly string[],
    publish: (signals: ReadonlyMap<string, AbortSignal>) => Promise<T>
  ): Promise<T> {
    const attempts = [...new Set(sessionIds)].map((sessionId) => this.beginPublication(sessionId))
    try {
      return await publish(new Map(attempts.map(({ sessionId, signal }) => [sessionId, signal])))
    } finally {
      for (const attempt of attempts) {
        attempt.end()
      }
    }
  }

  private beginPublication(sessionId: string) {
    const attempts = this.publications.get(sessionId) ?? new Set<AbortController>()
    this.publications.set(sessionId, attempts)
    const attempt = new AbortController()
    attempts.add(attempt)
    return {
      sessionId,
      signal: attempt.signal,
      end: () => {
        attempts.delete(attempt)
        if (attempts.size === 0 && this.publications.get(sessionId) === attempts) {
          this.publications.delete(sessionId)
        }
      }
    }
  }

  /** `track` for the close itself, past every check that could still refuse it. */
  commit<T>(
    sessionId: string,
    close: () => Promise<T>,
    request = this.closeRequest(sessionId)
  ): Promise<T> {
    request.cancelEarlierPublications()
    return this.track(sessionId, close)
  }

  private closeRequest(sessionId: string): StructuredAgentSessionCloseRequest {
    const earlier = [...(this.publications.get(sessionId) ?? [])]
    return {
      cancelEarlierPublications: () => {
        const attempts = this.publications.get(sessionId)
        for (const attempt of earlier) {
          attempt.abort(new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED))
          attempts?.delete(attempt)
        }
        if (attempts?.size === 0) {
          this.publications.delete(sessionId)
        }
      }
    }
  }

  /** Runs one close, marked in flight from this call until it settles. */
  track<T>(
    sessionId: string,
    close: (request: StructuredAgentSessionCloseRequest) => Promise<T>
  ): Promise<T> {
    const request = this.closeRequest(sessionId)
    const closes = this.bySession.get(sessionId) ?? new Set<Promise<unknown>>()
    this.bySession.set(sessionId, closes)
    // Marked before the close starts, so a reveal arriving during its first await already waits.
    const run = Promise.resolve().then(() => close(request))
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
