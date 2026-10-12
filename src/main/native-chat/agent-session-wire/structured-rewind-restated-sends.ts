// The sends a rewind restates beside the provider's items: exactly what the stopped-history
// derivation reads (agent-session-stopped-history.ts). Derived from the epoch being replaced.

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import type { JournalRestatedSend } from '../agent-session-journal/journal-rewind-restated-send-rows'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** Keyed by the id a rewind's retained row has: an accepted send's provider item, else its own. */
export type RewindRestatedSends = ReadonlyMap<string, JournalRestatedSend>

/** Each send Orca proved never reached the agent (it has no provider copy) and each send that
 *  carried stopped messages. After a /clear only what the rewind retires is restated. */
export function rewindRestatedSends(
  journal: Pick<AgentSessionJournal, 'submissions' | 'stoppedHistoryCarried'> & {
    context: Pick<AgentSessionJournal['context'], 'floor'>
  }
): RewindRestatedSends {
  const floor = journal.context.floor()?.sequence ?? 0
  const carried = journal.stoppedHistoryCarried()
  const sends = new Map<string, JournalRestatedSend>()
  for (const submission of journal.submissions()) {
    const carries = carried.get(submission.clientMessageId) ?? []
    const unwritten =
      submission.dispatchState === 'rejected' &&
      readAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true
    if (
      (!unwritten && carries.length === 0) ||
      (floor > 0 && (submission.acceptedSequence ?? 0) <= floor)
    ) {
      continue
    }
    const key =
      submission.dispatchState === 'accepted' && submission.providerItemId
        ? submission.providerItemId
        : agentJournalSubmissionKey(submission.clientMessageId)
    sends.set(key, { submission, carries })
  }
  return sends
}

/** The rebuilt rows, each restated send attached. A carrier keeps only the stopped messages
 *  restated beside it, so one the rewind removed gives back what it carried. */
export function withRewindRestatedSends(
  items: readonly JournalReplacementItem[],
  sends: RewindRestatedSends
): JournalReplacementItem[] {
  const restated = (item: JournalReplacementItem) =>
    item.body.kind === 'message' ? sends.get(agentJournalItemKey(item.identity)) : undefined
  const kept = new Set(
    items.flatMap((item) => {
      const send = restated(item)
      return send ? [send.submission.clientMessageId] : []
    })
  )
  return items.map((item) => {
    const send = restated(item)
    return send
      ? { ...item, send: { ...send, carries: send.carries.filter((id) => kept.has(id)) } }
      : item
  })
}
