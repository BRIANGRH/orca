// A rewind rebuilds history from the provider's items, which never hold a person's stopped message:
// Orca proved it never reached the agent as a send. So each one before the rewind point is restated
// with the rows that first recorded it, copied verbatim, and each append record the provider kept
// where it sat, so a kept message is never appended again.

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import { buildJournalSubmissionRow, journalRowBase } from './journal-row-builders'
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
  const body: AgentJournalMessageItem = item.body
  const { clientMessageId } = submission
  const rows: RowBuilder[] = [
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
    })
  ]
  // A fact this build cannot read is left off: the stored reason still classifies it.
  const rejection = readAgentSessionFailureFact(submission.rejection)
  rows.push((seq, ts) => ({
    kind: 'dispatch',
    clientMessageId,
    state: 'rejected',
    providerItemId: null,
    reason: submission.reason,
    ...(rejection ? { rejection } : {}),
    ...(submission.keptAsQueuedMessageId !== undefined
      ? { keptAsQueuedMessageId: submission.keptAsQueuedMessageId }
      : {}),
    ...journalRowBase(input.state.epoch, seq, fence, ts),
    ...(submission.recovered ? { recovered: submission.recovered } : {})
  }))
  return rows
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
