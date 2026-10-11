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
  sessionId: string
  cancelEarlierPublications: () => void
}

export type StructuredAgentSessionPublication = {
  signalFor: (sessionId: string) => AbortSignal
}

type PublicationAttempt = StructuredAgentSessionPublication & {
  cancel: (sessionId: string) => void
}

export class StructuredAgentSessionClosesInFlight {
  private readonly bySession = new Map<string, Set<Promise<unknown>>>()
  private readonly publications = new Set<PublicationAttempt>()

  /** Registered before preparation; a completed close cannot make this attempt current again. */
  async runPublication<T>(
    sessionId: string,
    publish: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return this.runPublicationInScope(new Set([sessionId]), (attempt) =>
      publish(attempt.signalFor(sessionId))
    )
  }

  /** Registered before preparation even when the host has not exposed its targets yet. */
  runRestoration<T>(
    restore: (attempt: StructuredAgentSessionPublication) => Promise<T>
  ): Promise<T> {
    return this.runPublicationInScope(null, restore)
  }

  private async runPublicationInScope<T>(
    scope: ReadonlySet<string> | null,
    publish: (attempt: StructuredAgentSessionPublication) => Promise<T>
  ): Promise<T> {
    const controllers = new Map<string, AbortController>()
    const controllerFor = (sessionId: string): AbortController => {
      let controller = controllers.get(sessionId)
      if (!controller) {
        controller = new AbortController()
        controllers.set(sessionId, controller)
      }
      return controller
    }
    const attempt: PublicationAttempt = {
      signalFor: (sessionId) => controllerFor(sessionId).signal,
      cancel: (sessionId) => {
        if (scope === null || scope.has(sessionId)) {
          controllerFor(sessionId).abort(new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED))
        }
      }
    }
    this.publications.add(attempt)
    try {
      return await publish(attempt)
    } finally {
      this.publications.delete(attempt)
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
    const earlier = [...this.publications]
    return {
      sessionId,
      cancelEarlierPublications: () => {
        for (const attempt of earlier) {
          attempt.cancel(sessionId)
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
