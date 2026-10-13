// The stopped sends a rewind restates beside the provider's items: each one Orca proved never
// reached the agent as a send, which the provider's items never hold. Derived from the epoch being
// replaced, with the append records Codex keeps (`agent-session-stopped-history.ts`).

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalStoppedHistory } from '../agent-session-journal/journal-stopped-message-appends'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { rewindBoundaryIndex, rewindProviderKey } from './structured-rewind-boundary'

/** The stopped sends, keyed by each one's own item id, which its retained row keeps. */
export type RewindRestatedSends = ReadonlyMap<string, AgentJournalSubmission>

type RewindJournal = Pick<AgentSessionJournal, 'submissions' | 'snapshot'> & {
  stoppedHistory: Pick<JournalStoppedHistory, 'appended'>
  context: Pick<AgentSessionJournal['context'], 'floor'>
}

/** After a /clear only what the rewind retires is restated. */
export function rewindRestatedSends(journal: RewindJournal): RewindRestatedSends {
  const floor = journal.context.floor()?.sequence ?? 0
  const sends = new Map<string, AgentJournalSubmission>()
  for (const submission of journal.submissions()) {
    if (
      submission.dispatchState === 'rejected' &&
      readAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true &&
      (floor === 0 || (submission.acceptedSequence ?? 0) > floor)
    ) {
      sends.set(agentJournalSubmissionKey(submission.clientMessageId), submission)
    }
  }
  return sends
}

/** The rebuilt rows, each restated send attached, and each append record whose own row precedes
 *  the rewound turn after the row it followed: Codex keeps a pair it injected before that turn and
 *  drops one after, even when the stopped bubble sits before the turn. */
export function withRewindRestatedSends(
  items: readonly JournalReplacementItem[],
  journal: RewindJournal,
  target: { threadId: string; turnId: string } | null,
  log: { logger: Pick<StructuredAgentSessionLogger, 'warn'>; sessionId: string }
): JournalReplacementItem[] {
  const sends = rewindRestatedSends(journal)
  const { items: rows, submissions } = journal.snapshot()
  // Keyed as the rebuilt rows are.
  const providerKey = rewindProviderKey(submissions)
  const cutRow = target
    ? rows[rewindBoundaryIndex(rows, target, journal.context.floor()?.sequence ?? 0, providerKey)]
    : undefined
  const cut = cutRow?.sequence ?? Number.POSITIVE_INFINITY
  const sequences = new Map(rows.map((row) => [providerKey(row.itemId), row.sequence]))
  const rebuilt = items.map((item) => {
    const send =
      item.body.kind === 'message' ? sends.get(agentJournalItemKey(item.identity)) : undefined
    return send ? { ...item, send } : { ...item }
  })
  const restated = new Set(
    rebuilt.flatMap((item) => (item.send ? [item.send.clientMessageId] : []))
  )
  for (const [appendId, record] of journal.stoppedHistory.appended()) {
    const messageIds = record.messageIds.filter((id) => restated.has(id))
    if (record.sequence >= cut || messageIds.length === 0) {
      continue
    }
    const after = rebuilt.findLastIndex(
      (item) => (sequences.get(agentJournalItemKey(item.identity)) ?? Infinity) < record.sequence
    )
    if (after === -1) {
      // A covered message's bubble always precedes its record; anchoring it anywhere else would
      // let a later rewind drop it and append the message twice.
      log.logger.warn('a kept stopped-message append has no row before it; not restated', {
        scope: 'stopped-history',
        sessionId: log.sessionId,
        appendId
      })
      continue
    }
    const anchor = rebuilt[after]!
    anchor.appendsAfter = [...(anchor.appendsAfter ?? []), { appendId, messageIds }]
  }
  return rebuilt
}
