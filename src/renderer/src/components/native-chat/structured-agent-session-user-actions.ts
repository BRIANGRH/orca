import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionMutationResult } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type StructuredSessionUserAction = Readonly<{
  sessionId: string
  clientMessageId: string
  kind: 'send' | 'card-send'
  target?: RuntimeClientTarget
}>
export type UserRequestSubmission = Pick<
  AgentJournalSubmission,
  | 'clientMessageId'
  | 'dispatchState'
  | 'providerItemId'
  | 'submittedSequence'
  | 'origin'
  | 'source'
  | 'queuedMessageId'
>
export type StructuredSessionUserActionObservation =
  | { kind: 'admitted' | 'issued'; action: StructuredSessionUserAction }
  | {
      kind: 'accepted'
      action: StructuredSessionUserAction
      epoch: string
      submission: UserRequestSubmission
    }
const listeners = new Set<(observation: StructuredSessionUserActionObservation) => void>()

/** Read-only observers cannot prevent a user's request from being sent. */
export function observeStructuredSessionUserAction(
  observation: StructuredSessionUserActionObservation
): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(observation)
    } catch (error) {
      console.warn('[native-chat] observing a user request failed', error)
    }
  }
}
export function subscribeStructuredSessionUserActions(
  listener: (observation: StructuredSessionUserActionObservation) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The existing mutation receipt is source evidence, including for an explicit held-card Send. */
export function observeStructuredSessionUserReceipt(
  action: StructuredSessionUserAction,
  result: AgentSessionMutationResult<unknown>
): void {
  if (
    !result.ok ||
    typeof result.cursor?.epoch !== 'string' ||
    typeof result.value !== 'object' ||
    result.value === null ||
    !('submission' in result.value)
  ) {
    return
  }
  const row = result.value.submission
  if (
    typeof row !== 'object' ||
    row === null ||
    !('clientMessageId' in row) ||
    row.clientMessageId !== action.clientMessageId ||
    !('dispatchState' in row) ||
    row.dispatchState !== 'accepted' ||
    !('providerItemId' in row) ||
    typeof row.providerItemId !== 'string' ||
    !row.providerItemId
  ) {
    return
  }
  const source =
    'source' in row &&
    typeof row.source === 'object' &&
    row.source !== null &&
    'kind' in row.source &&
    typeof row.source.kind === 'string'
      ? { kind: row.source.kind }
      : undefined
  const origin =
    'origin' in row && (row.origin === 'client' || row.origin === 'host') ? row.origin : undefined
  const queuedMessageId =
    'queuedMessageId' in row && typeof row.queuedMessageId === 'string'
      ? row.queuedMessageId
      : undefined
  observeStructuredSessionUserAction({
    kind: 'accepted',
    action,
    epoch: result.cursor.epoch,
    submission: {
      clientMessageId: row.clientMessageId,
      dispatchState: row.dispatchState,
      providerItemId: row.providerItemId,
      submittedSequence:
        'submittedSequence' in row && typeof row.submittedSequence === 'number'
          ? row.submittedSequence
          : undefined,
      source,
      origin,
      queuedMessageId
    }
  })
}
