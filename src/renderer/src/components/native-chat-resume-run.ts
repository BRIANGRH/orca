import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import type { RestartContinuationOutcome } from './native-chat-restart-action-notifications'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

export type ResumeRunHostStatus = Pick<
  AgentSessionStatusSummary,
  'restartResume' | 'hostExecutionPhase'
> &
  Partial<ResumeRunRecoveryStatus>

export type ResumeRunRecoveryStatus = Pick<
  AgentSessionStatusSummary,
  'latestPrompt' | 'statusStartedAt' | 'hostExecutionOwned' | 'hostExecutionPhase' | 'turnOutcome'
>

/** Who started a run: this launch's "resume automatically" preference, or the user's own click. */
export type ResumeRunStarter = 'launch' | 'user'

/** Selection and history belong to this window; live progress and failures belong to the host. */
export type ResumeRun = Readonly<{
  startedAt: number
  startedBy: ResumeRunStarter
  entries: readonly Readonly<{
    candidate: ResumeCandidate
    /** Host observation from this run, before any later user recovery. */
    observedStatus?: ResumeRunHostStatus
    dismissed?: true
  }>[]
  inFlight: boolean
  continued?: readonly RestartContinuationOutcome[]
  finishedViewShown?: boolean
}>

function progressRank(status: ResumeRunHostStatus | undefined): number {
  const phase = status?.restartResume?.phase
  if (phase === 'starting') {
    return status?.hostExecutionPhase === 'ready' ? 4 : 3
  }
  if (phase === 'queued') {
    return 2
  }
  if (phase === 'skipped') {
    return 1
  }
  return phase === 'continued' || phase === 'refused' || phase === 'unconfirmed' ? 5 : 0
}

/** Clearing live fields cannot undo progress this action already showed. */
export function observeResumeRun(
  run: ResumeRun,
  statusFor: (sessionId: string) => ResumeRunHostStatus | undefined
): ResumeRun {
  if (!run.inFlight) {
    return run
  }
  let changed = false
  const entries = run.entries.map((entry) => {
    const status = statusFor(entry.candidate.sessionId)
    if (progressRank(status) <= progressRank(entry.observedStatus)) {
      return entry
    }
    changed = true
    return {
      ...entry,
      observedStatus: {
        restartResume: status?.restartResume,
        hostExecutionPhase: status?.hostExecutionPhase,
        hostExecutionOwned: status?.hostExecutionOwned,
        latestPrompt: status?.latestPrompt,
        statusStartedAt: status?.statusStartedAt,
        turnOutcome: status?.turnOutcome
      }
    }
  })
  return changed ? { ...run, entries } : run
}

/** The reply closes this run's observation; later status belongs to the user's recovery. */
export function finishResumeRun(
  run: ResumeRun,
  skipped: ReadonlySet<string>,
  continued: ResumeRun['continued'],
  statusFor: (sessionId: string) => ResumeRunHostStatus | undefined
): ResumeRun {
  return {
    ...run,
    entries: run.entries
      .filter((entry) => !skipped.has(entry.candidate.sessionId))
      .map((entry) => ({
        ...entry,
        observedStatus:
          entry.observedStatus?.latestPrompt !== undefined
            ? entry.observedStatus
            : { ...statusFor(entry.candidate.sessionId), ...entry.observedStatus }
      })),
    inFlight: false,
    continued
  }
}

/** Dismissal is user action history: the same host removal can otherwise also mean recovery. */
export function markResumeRunDismissed(
  run: ResumeRun,
  dismissed: readonly string[] | undefined,
  remaining: readonly string[]
): ResumeRun {
  const remainingIds = new Set(remaining)
  return {
    ...run,
    entries: run.entries.map((entry) =>
      (dismissed === undefined || dismissed.includes(entry.candidate.sessionId)) &&
      !remainingIds.has(entry.candidate.sessionId)
        ? { ...entry, dismissed: true }
        : entry
    )
  }
}

export function resumeRunInFlight(run: ResumeRun | null): boolean {
  return run?.inFlight ?? false
}

export function beginResumeRun(
  candidates: readonly ResumeCandidate[],
  now: number,
  startedBy: ResumeRunStarter
): ResumeRun {
  return {
    startedAt: now,
    startedBy,
    entries: candidates.map((candidate) => ({ candidate })),
    inFlight: true
  }
}

const NONE: readonly string[] = []
/** Keep the selection protected until the action's authoritative reply has been published. */
export function resumeRunPendingIds(run: ResumeRun | null): readonly string[] {
  return run?.inFlight ? run.entries.map((entry) => entry.candidate.sessionId) : NONE
}
