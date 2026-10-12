// A rewind rebuilds history from the provider's items, which hold none of the host's facts about a
// send. A send the stopped-history derivation reads (one Orca proved never reached the agent, or one
// that carried stopped messages) is restated with the rows that first recorded it, copied verbatim.

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission,
  type AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import { buildJournalSubmissionRow, journalRowBase } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalDispatchRow, JournalRow } from './journal-row-schema'
import type { JournalReplacementItem } from './journal-epoch-replacement'

export type JournalRestatedSend = {
  submission: AgentJournalSubmission
  /** What it carries in the rebuilt history: only stopped messages restated beside it. */
  carries: readonly string[]
}

/** The submission and dispatch rows that restate `item`'s send, in the order they were first
 *  written; empty when the item restates none. */
export function journalRestatedSendRows(input: {
  state: JournalReducerState
  providerHandle: AgentSessionJournalProviderHandle
  fence: number
  item: JournalReplacementItem
}): ((seq: number, ts: number) => JournalRow)[] {
  const { item, fence } = input
  const send = item.send
  if (!send || item.body.kind !== 'message') {
    return []
  }
  const body: AgentJournalMessageItem = item.body
  const { submission, carries } = send
  const { clientMessageId } = submission
  const base = (seq: number, ts: number) => ({
    ...journalRowBase(input.state.epoch, seq, fence, ts),
    ...(submission.recovered ? { recovered: submission.recovered } : {})
  })
  const rows: ((seq: number, ts: number) => JournalRow)[] = [
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
  if (submission.handedOverAt !== undefined || carries.length > 0) {
    rows.push((seq, ts) => ({
      kind: 'dispatch',
      clientMessageId,
      state: 'pending',
      providerItemId: null,
      reason: null,
      ...journalRowBase(input.state.epoch, seq, fence, ts),
      turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE,
      ...(carries.length > 0 ? { carries: [...carries] } : {})
    }))
  }
  const settled = settlingDispatch(submission)
  if (settled) {
    rows.push((seq, ts) => ({ ...settled, clientMessageId, ...base(seq, ts) }))
  }
  return rows
}

type SettlingDispatch = Pick<
  JournalDispatchRow,
  'kind' | 'state' | 'providerItemId' | 'reason' | 'rejection' | 'keptAsQueuedMessageId'
> & { answeredInTurn?: JournalDispatchRow['answeredInTurn'] }

/** The row that settled it, as the reducer folded it; none while it is still pending. */
function settlingDispatch(submission: AgentJournalSubmission): SettlingDispatch | null {
  if (submission.dispatchState === 'accepted') {
    return {
      kind: 'dispatch',
      state: 'accepted',
      providerItemId: submission.providerItemId,
      reason: null
    }
  }
  if (submission.dispatchState === 'unknown') {
    return { kind: 'dispatch', state: 'unknown', providerItemId: null, reason: submission.reason }
  }
  if (submission.dispatchState !== 'rejected') {
    return null
  }
  // A fact this build cannot read is left off: the stored reason still classifies it.
  const rejection = readAgentSessionFailureFact(submission.rejection)
  return {
    kind: 'dispatch',
    state: 'rejected',
    providerItemId: null,
    reason: submission.reason,
    ...(rejection ? { rejection } : {}),
    ...(submission.keptAsQueuedMessageId !== undefined
      ? { keptAsQueuedMessageId: submission.keptAsQueuedMessageId }
      : {}),
    ...(submission.answeredInTurn !== undefined
      ? { answeredInTurn: submission.answeredInTurn }
      : {})
  }
}
