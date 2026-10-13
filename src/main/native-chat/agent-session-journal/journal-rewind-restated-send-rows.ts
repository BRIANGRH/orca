// A rewind rebuilds history from the provider's items, which never hold a person's stopped message:
// Orca proved it never reached the agent as a send. So each one before the rewind point is restated
// with the rows that first recorded it, copied verbatim, and each append record the provider kept
// where it sat, so a kept message is never appended again.

import {
  isSubmissionRejectionFact,
  readAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import { buildJournalSubmissionRow, journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { buildJournalStoppedMessageAppendRow } from './journal-stopped-message-appends'

type RowBuilder = (seq: number, ts: number) => JournalRow

/** The submission and rejection rows that restate `item`'s stopped send; empty when the item
 *  restates none. A Stop withdrew it while queued, so no handover row was ever written. */
export function journalRestatedSendRows(input: {
  state: JournalReducerState
  providerHandle: AgentSessionJournalProviderHandle
  fence: number
  item: JournalReplacementItem
}): RowBuilder[] {
  const { item, fence } = input
  const submission = item.send
  if (!submission || item.body.kind !== 'message' || submission.dispatchState !== 'rejected') {
    return []
  }
  // `rewindRestatedSends` admits only a send whose rejection this build reads.
  const fact = readAgentSessionFailureFact(submission.rejection)
  if (!fact || !isSubmissionRejectionFact(fact)) {
    return []
  }
  const body: AgentJournalMessageItem = item.body
  const { clientMessageId } = submission
  const dispatch = journalDispatchRowBuilder(() => input.state, {
    clientMessageId,
    fence,
    state: 'rejected',
    ...agentSessionFailureWords(fact, { surface: 'rejection' }),
    ...(submission.keptAsQueuedMessageId !== undefined
      ? { keptAsQueuedMessageId: submission.keptAsQueuedMessageId }
      : {}),
    ...(submission.recovered ? { recovered: submission.recovered } : {})
  })
  return [
    (seq, ts) => ({
      ...buildJournalSubmissionRow({
        state: input.state,
        clientMessageId,
        payloadFingerprint: submission.payloadFingerprint,
        providerHandle: input.providerHandle,
        body,
        seq,
        fence,
        ts,
        ...(submission.handoverRecorded ? { handoverRecorded: true } : {}),
        ...(submission.queuedMessageId !== undefined
          ? { queuedMessageId: submission.queuedMessageId }
          : {}),
        ...(submission.origin !== undefined ? { origin: submission.origin } : {})
      }),
      // As stored, a newer build's kind too.
      ...(submission.source !== undefined ? { source: { kind: submission.source.kind } } : {})
    }),
    // The words as stored, which named the agent; the fact alone cannot.
    (seq, ts) => ({ ...dispatch(seq, ts), reason: submission.reason })
  ]
}

/** The append records that sat just after `item`. */
export function journalRestatedAppendRows(input: {
  state: JournalReducerState
  fence: number
  item: JournalReplacementItem
}): RowBuilder[] {
  return (input.item.appendsAfter ?? []).map(
    (append) => (seq, ts) =>
      buildJournalStoppedMessageAppendRow({
        state: input.state,
        seq,
        fence: input.fence,
        ts,
        append
      })
  )
}
