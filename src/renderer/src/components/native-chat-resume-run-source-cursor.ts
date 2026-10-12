import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { findStructuredAgentSessionReadOwner } from './native-chat/structured-agent-session-read-owner'
import { resumeRunUserRequestConfirmed, type ResumeRun } from './native-chat-resume-run'
const LOCAL = { kind: 'local' } as const
export function resumeRunSourceCursor(sessionId: string): AgentJournalCursor | undefined {
  return (
    findStructuredAgentSessionReadOwner(sessionId, LOCAL)?.getSnapshot().state.cursor ?? undefined
  )
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
  operation: number
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
      return { ...entry, dismissal, localAction: undefined, userRequest: undefined }
    })
  }
}
