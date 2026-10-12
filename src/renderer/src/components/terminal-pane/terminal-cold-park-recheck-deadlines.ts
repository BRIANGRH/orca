/**
 * Why: parking decisions change only at the cold-park, hot-retain, retention
 * TTL, and post-measure cool-down deadlines, so the verdict effects schedule
 * one recheck at the next deadline instead of polling.
 */
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'

function nextColdParkDeadlineDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs: number
  hotRetainMs: number
  retentionTtlMs?: number
  parkCooldownUntilMs?: number | null
  parkVerdictPinUntilMs?: number | null
}): number | null {
  if (!args.parkingEnabled || args.hiddenSinceMs === null) {
    return null
  }
  const pendingDeadlines = [
    args.hiddenSinceMs + args.coldParkDelayMs,
    args.hiddenSinceMs + args.hotRetainMs,
    ...(args.retentionTtlMs !== undefined ? [args.hiddenSinceMs + args.retentionTtlMs] : []),
    // Why: the cool-down holds past-deadline candidates out of the parked set; without this wakeup nothing re-parks them.
    ...(args.parkCooldownUntilMs != null ? [args.parkCooldownUntilMs] : []),
    // Why: damping stops the churn that would otherwise wake this deadline.
    ...(args.parkVerdictPinUntilMs != null ? [args.parkVerdictPinUntilMs] : [])
  ].filter((deadlineMs) => deadlineMs > args.nowMs)
  return pendingDeadlines.length === 0 ? null : Math.min(...pendingDeadlines) - args.nowMs
}

export function getTerminalWorktreeColdParkRecheckDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  /** Provided only for retention-budget candidates so their TTL wakes the verdict effect. */
  retentionTtlMs?: number
  parkCooldownUntilMs?: number | null
}): number | null {
  return nextColdParkDeadlineDelayMs({
    parkingEnabled: args.parkingEnabled,
    hiddenSinceMs: args.hiddenSinceMs,
    nowMs: args.nowMs,
    coldParkDelayMs: args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS,
    ...(args.retentionTtlMs !== undefined ? { retentionTtlMs: args.retentionTtlMs } : {}),
    parkCooldownUntilMs: args.parkCooldownUntilMs
  })
}

export function getTerminalTabColdParkRecheckDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  parkCooldownUntilMs?: number | null
  /** Provided only for tabs damped out of the parked set by flip churn. */
  parkVerdictPinUntilMs?: number | null
}): number | null {
  return nextColdParkDeadlineDelayMs({
    parkingEnabled: args.parkingEnabled,
    hiddenSinceMs: args.hiddenSinceMs,
    nowMs: args.nowMs,
    coldParkDelayMs: args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS,
    parkCooldownUntilMs: args.parkCooldownUntilMs,
    parkVerdictPinUntilMs: args.parkVerdictPinUntilMs
  })
}

/** Next recheck deadline per hidden, still-mounted tab; parked and visible tabs need none. */
export function collectTerminalTabColdParkRecheckDeadlines(args: {
  candidates: readonly {
    id: string
    isVisible: boolean
    hasActivityTerminalPortal: boolean
    hiddenSinceMs: number | null
  }[]
  parkedTabIds: ReadonlySet<string>
  parkVerdictPinUntilMsByTabId: ReadonlyMap<string, number>
  parkingEnabled: boolean
  parkCooldownUntilMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
}): Map<string, number> {
  const deadlineMsByTabId = new Map<string, number>()
  for (const candidate of args.candidates) {
    if (
      candidate.isVisible ||
      candidate.hasActivityTerminalPortal ||
      args.parkedTabIds.has(candidate.id)
    ) {
      continue
    }
    const delayMs = getTerminalTabColdParkRecheckDelayMs({
      parkingEnabled: args.parkingEnabled,
      hiddenSinceMs: candidate.hiddenSinceMs,
      parkCooldownUntilMs: args.parkCooldownUntilMs,
      // Why: pin expiry may be the only remaining wakeup after damping stops churn.
      parkVerdictPinUntilMs: args.parkVerdictPinUntilMsByTabId.get(candidate.id) ?? null,
      nowMs: args.nowMs,
      ...(args.coldParkDelayMs !== undefined ? { coldParkDelayMs: args.coldParkDelayMs } : {}),
      ...(args.hotRetainMs !== undefined ? { hotRetainMs: args.hotRetainMs } : {})
    })
    if (delayMs !== null && delayMs > 0) {
      deadlineMsByTabId.set(candidate.id, args.nowMs + delayMs)
    }
  }
  return deadlineMsByTabId
}
