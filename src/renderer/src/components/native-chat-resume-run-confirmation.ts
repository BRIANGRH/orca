import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'
import { resumeRunUserRequestConfirmed, type ResumeRun } from './native-chat-resume-run'

/** A reply is admissible only for an accepted source present when its request began. */
export function confirmResumeRunSource(
  run: ResumeRun,
  offer: NativeChatRestartOffer,
  issued: ResumeRun | null
): ResumeRun {
  if (!offer.available || !issued) {
    return run
  }
  const before = new Map(
    issued.entries.map((entry) => [entry.candidate.sessionId, entry.userRequest])
  )
  const candidates = new Map(offer.candidates.map((row) => [row.sessionId, row]))
  const failures = new Map(offer.failed.map((row) => [row.sessionId, row]))
  let changed = false
  const entries = run.entries.map((entry) => {
    const witness = entry.userRequest
    const source = before.get(entry.candidate.sessionId)
    if (
      !witness ||
      resumeRunUserRequestConfirmed(entry) ||
      source?.submission !== witness.submission ||
      source.epoch !== witness.epoch
    ) {
      return entry
    }
    changed = true
    return {
      ...entry,
      userRequest: {
        ...witness,
        offer: {
          listedAt: offer.listedAt,
          candidate: candidates.get(entry.candidate.sessionId),
          failure: failures.get(entry.candidate.sessionId)
        }
      }
    }
  })
  return changed ? { ...run, entries } : run
}

export function hasLaterResumeRunSource(
  current: ResumeRun | null,
  issued: ResumeRun | null
): boolean {
  const sources = new Set(issued?.entries.map((entry) => entry.userRequest?.submission))
  return (
    current?.entries.some(
      (entry) => entry.userRequest && !sources.has(entry.userRequest.submission)
    ) ?? false
  )
}
