import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { observeResumeRun, type ResumeRun } from './native-chat-resume-run'

/** Capture every frame, even while the dialog is closed or React batches renders. */
export function watchResumeRunStatus(
  current: () => ResumeRun | null,
  publish: (run: ResumeRun) => void
): () => void {
  const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
  const notice = () => {
    const run = current()
    if (!run) {
      return
    }
    const snapshot = feed.getSnapshot()
    const next = observeResumeRun(run, (sessionId) => snapshot.get(sessionId))
    if (next !== run) {
      publish(next)
    }
  }
  const unsubscribe = feed.subscribe(notice)
  const deactivate = feed.activate()
  return () => {
    unsubscribe()
    deactivate()
  }
}

/** Cheap wakeups for a retained result; prose does not admit another history read. */
export function watchResumeRunActivity(
  entries: () => ResumeRun['entries'],
  observe: (id: string) => void
): () => void {
  const activity = new Map<string, string>()
  const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
  const notice = () => {
    for (const entry of entries()) {
      const id = entry.candidate.sessionId
      const status = feed.getSnapshot().get(id)
      const key = JSON.stringify([
        status?.status,
        status?.latestPrompt,
        status?.statusStartedAt,
        status?.hostExecutionOwned,
        status?.hostExecutionPhase
      ])
      const before = activity.get(id)
      activity.set(id, key)
      if (before !== undefined && before !== key) {
        observe(id)
      }
    }
  }
  notice()
  return feed.subscribe(notice)
}
