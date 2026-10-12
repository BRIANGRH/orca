import { useEffect, useSyncExternalStore } from 'react'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useAppStore } from '../store'
import type {
  ResumeRun,
  ResumeRunHostStatus,
  ResumeRunRecoveryStatus
} from './native-chat-resume-run'

/** The existing host feed and tab inventory prove activity; closed chats cannot establish recovery. */
export function useResumeRunHostStatus(
  run: ResumeRun | null
): (sessionId: string) => (ResumeRunHostStatus & Partial<ResumeRunRecoveryStatus>) | undefined {
  const owner = getStructuredAgentSessionStatusFeed({ kind: 'local' })
  const continuedIds = new Set(
    run?.continued
      ?.filter((result) => result.outcome === 'continued')
      .map((result) => result.sessionId)
  )
  const recoveryIds = run?.inFlight
    ? []
    : (run?.entries
        .filter((entry) => !continuedIds.has(entry.candidate.sessionId))
        .map((entry) => entry.candidate.sessionId) ?? [])
  const enabled = recoveryIds.length > 0
  useEffect(() => (enabled ? owner.activate() : undefined), [owner, enabled])
  // Assistant prose and subagent updates do not change recovery evidence.
  const activityKey = () =>
    JSON.stringify(
      recoveryIds.map((sessionId) => {
        const status = owner.getSnapshot().get(sessionId)
        return [
          sessionId,
          owner.getSessionObservation(sessionId),
          status?.latestPrompt,
          status?.statusStartedAt,
          status?.hostExecutionOwned,
          status?.hostExecutionPhase,
          status?.turnOutcome
        ]
      })
    )
  useSyncExternalStore(owner.subscribe, activityKey, activityKey)
  const snapshot = owner.getSnapshot()
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree)
  const workspaceIds = new Set(run?.entries.map((entry) => entry.candidate.workspaceId))
  const openIds = new Set(
    [...workspaceIds].flatMap((workspaceId) =>
      (tabs[workspaceId] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => tab.entityId)
    )
  )
  return (sessionId) => {
    if (!openIds.has(sessionId)) {
      return undefined
    }
    return owner.getSessionObservation(sessionId) === 'live' ? snapshot.get(sessionId) : undefined
  }
}

/** Missing inventory is unknown; a lost status stream does not close an open tab. */
export function useResumeRunInventory(
  run: ResumeRun | null
): (sessionId: string) => 'open' | 'closed' | 'unknown' {
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree)
  const entries = new Map(run?.entries.map((entry) => [entry.candidate.sessionId, entry.candidate]))
  return (sessionId) => {
    const candidate = entries.get(sessionId)
    const workspaceTabs = candidate ? tabs[candidate.workspaceId] : undefined
    if (!workspaceTabs) {
      return 'unknown'
    }
    return workspaceTabs.some(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
    )
      ? 'open'
      : 'closed'
  }
}
