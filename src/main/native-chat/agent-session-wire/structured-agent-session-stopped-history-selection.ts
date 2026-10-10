// Which stopped messages a handover carries to the agent, chosen in the session's serialized
// handover step so a phone and a desktop sending at once select each one once.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentSessionCanCarryStoppedHistory,
  agentSessionStoppedHistoryOwed
} from '../../../shared/agent-session-stopped-history'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StoppedHistorySelection = {
  ids: string[]
  bodies: AgentJournalMessageItem[]
}

const NONE: StoppedHistorySelection = { ids: [], bodies: [] }

/** None for a steer into a running turn, which may never record it, or for anything but a
 *  person's ordinary send; none when they would not fit beside it, so history never refuses a send. */
export async function selectStoppedHistory(
  ctx: {
    sessionId: string
    journal: Pick<AgentSessionJournal, 'submissions' | 'stoppedHistoryCarried' | 'itemBody'> & {
      context: Pick<AgentSessionJournal['context'], 'floor'>
    }
    adapter: Pick<StructuredAgentSessionAdapter, 'historyFits'>
    logger?: StructuredAgentSessionLogger
  },
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem,
  turnScope: AgentJournalTurnScope
): Promise<StoppedHistorySelection> {
  if (turnScope.kind !== 'thread' || !agentSessionCanCarryStoppedHistory(submission, body)) {
    return NONE
  }
  const owed = agentSessionStoppedHistoryOwed({
    submissions: ctx.journal.submissions(),
    carried: ctx.journal.stoppedHistoryCarried(),
    clearSequence: ctx.journal.context.floor()?.sequence ?? 0,
    body: (id) => ctx.journal.itemBody(agentJournalSubmissionKey(id))
  })
  const selected = owed.flatMap((entry) => {
    const stopped = ctx.journal.itemBody(agentJournalSubmissionKey(entry.clientMessageId))
    return stopped?.kind === 'message' ? [{ id: entry.clientMessageId, body: stopped }] : []
  })
  if (selected.length === 0) {
    return NONE
  }
  const bodies = selected.map((entry) => entry.body)
  try {
    const fits =
      (await ctx.adapter.historyFits?.({
        sessionId: ctx.sessionId,
        body,
        history: bodies
      })) ?? true
    return fits ? { ids: selected.map((entry) => entry.id), bodies } : NONE
  } catch (error) {
    ctx.logger?.warn('checking stopped history failed', {
      scope: 'stopped-history',
      sessionId: ctx.sessionId,
      error
    })
    return NONE
  }
}
