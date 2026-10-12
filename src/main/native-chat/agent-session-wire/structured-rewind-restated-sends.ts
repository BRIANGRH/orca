// The stopped sends a rewind restates beside the provider's items: each one Orca proved never
// reached the agent as a send, which the provider's items never hold. Derived from the epoch being
// replaced, with the append record that covers each (`agent-session-stopped-history.ts`).

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import type { JournalRestatedSend } from '../agent-session-journal/journal-rewind-restated-send-rows'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalStoppedHistory } from '../agent-session-journal/journal-stopped-message-appends'

/** Keyed by the stopped send's own item id, which its retained row keeps. */
export type RewindRestatedSends = ReadonlyMap<string, JournalRestatedSend>

/** After a /clear only what the rewind retires is restated. */
export function rewindRestatedSends(
  journal: Pick<AgentSessionJournal, 'submissions'> & {
    stoppedHistory: Pick<JournalStoppedHistory, 'appended'>
    context: Pick<AgentSessionJournal['context'], 'floor'>
  }
): RewindRestatedSends {
  const floor = journal.context.floor()?.sequence ?? 0
  const appendIds = new Map<string, string>()
  for (const [appendId, messageIds] of journal.stoppedHistory.appended()) {
    messageIds.forEach((id) => appendIds.set(id, appendId))
  }
  const sends = new Map<string, JournalRestatedSend>()
  for (const submission of journal.submissions()) {
    if (
      submission.dispatchState !== 'rejected' ||
      readAgentSessionFailureFact(submission.rejection)?.neverReachedAgent !== true ||
      (floor > 0 && (submission.acceptedSequence ?? 0) <= floor)
    ) {
      continue
    }
    const appendId = appendIds.get(submission.clientMessageId)
    sends.set(agentJournalSubmissionKey(submission.clientMessageId), {
      submission,
      ...(appendId !== undefined ? { appendId } : {})
    })
  }
  return sends
}

/** The rebuilt rows, each restated send attached. */
export function withRewindRestatedSends(
  items: readonly JournalReplacementItem[],
  sends: RewindRestatedSends
): JournalReplacementItem[] {
  return items.map((item) => {
    const send =
      item.body.kind === 'message' ? sends.get(agentJournalItemKey(item.identity)) : undefined
    return send ? { ...item, send } : item
  })
}
