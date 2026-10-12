import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { NativeChatRestartOffer } from './native-chat-resume-on-restart-store'

export type HostOfferRead = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeFailure[]
  available: boolean
}

/** The host's answer as this side understands it. `failed` is optional on the wire: an older host
 *  never sends it, and its absence means nothing to show, not an invalid answer. */
export type HostOfferPayload = { sessions?: unknown; failed?: unknown }

export function restartOfferFailures(payload: HostOfferPayload): ResumeFailure[] {
  // SAFETY: the host is the single writer of this shape; a malformed row is a host bug, not input.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return Array.isArray(payload.failed) ? (payload.failed as ResumeFailure[]) : []
}

export async function readNativeChatResumeHostOffer(deps: {
  target: RuntimeClientTarget
  current: () => boolean
  answer: (offer: Omit<NativeChatRestartOffer, 'available'>) => void
  unavailable: () => void
}): Promise<HostOfferRead> {
  try {
    const offered = await callStructuredAgentSession<HostOfferPayload>(
      deps.target,
      'agentSession.restartResumable'
    )
    if (!Array.isArray(offered.sessions)) {
      throw new Error('agent_session_restart_offer_invalid')
    }
    const failed = restartOfferFailures(offered)
    if (deps.current()) {
      deps.answer({ candidates: offered.sessions, failed, listedAt: Date.now() })
    }
    return { candidates: offered.sessions, failed, available: true }
  } catch {
    if (deps.current()) {
      deps.unavailable()
    }
    return { candidates: [], failed: [], available: false }
  }
}

export function createResumeOfferRead(
  target: RuntimeClientTarget,
  answer: (offer: Omit<NativeChatRestartOffer, 'available'>) => void,
  unavailable: () => void
): (current?: () => boolean) => Promise<HostOfferRead> {
  return (current = () => true) =>
    readNativeChatResumeHostOffer({ target, current, answer, unavailable })
}
