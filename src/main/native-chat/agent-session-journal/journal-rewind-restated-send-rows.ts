// A rewind rebuilds history from the provider's items, which never hold a person's stopped message:
// Orca proved it never reached the agent as a send. So each one before the rewind point is restated
// with the rows that first recorded it, copied verbatim, and with the append record that covers it,
// so it keeps its bubble and is never appended again.

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission,
  type AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import { buildJournalSubmissionRow, journalRowBase } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { buildJournalStoppedMessageAppendRow } from './journal-stopped-message-appends'

export type JournalRestatedSend = {
  submission: AgentJournalSubmission
  /** The append whose record covers it, when one does. */
  appendId?: string
}

type RowBuilder = (seq: number, ts: number) => JournalRow

/** The submission and dispatch rows that restate `item`'s stopped send, in the order they were
 *  first written; empty when the item restates none. */
export function journalRestatedSendRows(input: {
  state: JournalReducerState
  providerHandle: AgentSessionJournalProviderHandle
  fence: number
  item: JournalReplacementItem
}): RowBuilder[] {
  const { item, fence } = input
  const send = item.send
  if (!send || item.body.kind !== 'message' || send.submission.dispatchState !== 'rejected') {
    return []
  }
  const body: AgentJournalMessageItem = item.body
  const { submission } = send
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
  if (submission.handedOverAt !== undefined) {
    rows.push((seq, ts) => ({
      kind: 'dispatch',
      clientMessageId,
      state: 'pending',
      providerItemId: null,
      reason: null,
      ...journalRowBase(input.state.epoch, seq, fence, ts),
      turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    }))
  }
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
    ...(submission.answeredInTurn !== undefined
      ? { answeredInTurn: submission.answeredInTurn }
      : {}),
    ...journalRowBase(input.state.epoch, seq, fence, ts),
    ...(submission.recovered ? { recovered: submission.recovered } : {})
  }))
  return rows
}

/** Each append record that covers a restated send, naming only the sends restated with it. */
export function journalRestatedAppendRows(input: {
  state: JournalReducerState
  fence: number
  items: readonly JournalReplacementItem[]
}): RowBuilder[] {
  const appends = new Map<string, string[]>()
  for (const { send } of input.items) {
    if (send?.appendId !== undefined) {
      appends.set(send.appendId, [
        ...(appends.get(send.appendId) ?? []),
        send.submission.clientMessageId
      ])
    }
  }
  return [...appends].map(
    ([appendId, messageIds]) =>
      (seq, ts) =>
        buildJournalStoppedMessageAppendRow({
          state: input.state,
          seq,
          fence: input.fence,
          ts,
          append: { appendId, messageIds }
        })
  )
}
