import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { findStructuredAgentSessionReadOwner } from './native-chat/structured-agent-session-read-owner'
import { resumeRunUserRequestConfirmed, type ResumeRun } from './native-chat-resume-run'
const LOCAL = { kind: 'local' } as const
export function resumeRunSourceCursor(sessionId: string): AgentJournalCursor | undefined {
  return (
    findStructuredAgentSessionReadOwner(sessionId, LOCAL)?.getSnapshot().state.cursor ?? undefined
  )
}

/** One tiny checkpoint is background bookkeeping, never a gate on a user action. */
export async function readResumeRunSourceCursor(
  sessionId: string
): Promise<AgentJournalCursor | undefined> {
  try {
    const result = await callStructuredAgentSession<AgentSessionHistoryResult>(
      LOCAL,
      'agentSession.history',
      { sessionId, direction: 'tail', limit: 1 }
    )
    return result.ok === true ? result.page.liveCursor : undefined
  } catch {
    return undefined
  }
}

export function captureResumeRunSource(run: ResumeRun): ResumeRun {
  return {
    ...run,
    entries: run.entries.map((entry) => ({
      ...entry,
      sourceCursor: resumeRunSourceCursor(entry.candidate.sessionId)
    }))
  }
}

/** Intent is captured before the write; its source cut has the same finite lifetime as the run. */
export function captureResumeRunDismissal(
  run: ResumeRun,
  ids: readonly string[] | undefined,
  operation: number,
  current: () => ResumeRun | null,
  publish: (run: ResumeRun) => void
): ResumeRun {
  return {
    ...run,
    entries: run.entries.map((entry) => {
      if (
        (ids !== undefined && !ids.includes(entry.candidate.sessionId)) ||
        resumeRunUserRequestConfirmed(entry)
      ) {
        return entry
      }
      const dismissal = {
        operation,
        cursor: resumeRunSourceCursor(entry.candidate.sessionId),
        previousRequestId: entry.userRequest?.submission.clientMessageId
      }
      if (!dismissal.cursor) {
        void readResumeRunSourceCursor(entry.candidate.sessionId).then((cursor) => {
          const active = current()
          if (!cursor || !active) {
            return
          }
          publish({
            ...active,
            entries: active.entries.map((row) =>
              row.dismissal === dismissal ? { ...row, dismissal: { ...dismissal, cursor } } : row
            )
          })
        })
      }
      return { ...entry, dismissal }
    })
  }
}
