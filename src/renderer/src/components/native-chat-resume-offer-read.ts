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
}): Promise<HostOfferRead | undefined> {
  try {
    const offered = await callStructuredAgentSession<HostOfferPayload>(
      deps.target,
      'agentSession.restartResumable'
    )
    if (!deps.current()) {
      return undefined
    }
    if (!Array.isArray(offered.sessions)) {
      throw new Error('agent_session_restart_offer_invalid')
    }
    const failed = restartOfferFailures(offered)
    deps.answer({ candidates: offered.sessions, failed, listedAt: Date.now() })
    return deps.current() ? { candidates: offered.sessions, failed, available: true } : undefined
  } catch {
    if (!deps.current()) {
      return undefined
    }
    deps.unavailable()
    return deps.current() ? { candidates: [], failed: [], available: false } : undefined
  }
}

export function createResumeOfferRead(
  target: RuntimeClientTarget,
  prepareRequest: () => {
    current: () => boolean
    answer: (offer: Omit<NativeChatRestartOffer, 'available'>) => void
  },
  unavailable: () => void
): () => Promise<HostOfferRead | undefined> {
  let generation = 0
  return () => {
    const issued = ++generation
    const request = prepareRequest()
    return readNativeChatResumeHostOffer({
      target,
      current: () => generation === issued && request.current(),
      answer: request.answer,
      unavailable
    })
  }
}

/** Startup retries unavailable reads; supersession ends that launch's decision. */
export async function readLaunchResumeOffer(
  read: () => Promise<HostOfferRead | undefined>
): Promise<HostOfferRead | undefined> {
  let result = await read()
  // Host startup can race the renderer; a confirmed empty answer must never be retried.
  for (const delay of [100, 250, 500]) {
    if (!result || result.available) {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    result = await read()
  }
  return result
}
