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
import { stoppedMessageWithoutImages } from './structured-agent-session-stopped-history-frame'

export type StoppedHistorySelection = {
  ids: string[]
  bodies: AgentJournalMessageItem[]
}

export const NO_STOPPED_HISTORY: StoppedHistorySelection = { ids: [], bodies: [] }

/** Logs a send that went without the stopped history it was to carry; that history stays listed
 *  as carried, so the drop is visible only here. */
export function stoppedHistoryLeftOutLog(
  logger: StructuredAgentSessionLogger | undefined,
  sessionId?: string
): (error: unknown) => void {
  return (error) =>
    logger?.warn('stopped history left out of a send', {
      scope: 'stopped-history',
      ...(sessionId ? { sessionId } : {}),
      error
    })
}

/** None for a steer into a running turn, which may never record it, or for anything but a
 *  person's ordinary send. If the history does not fit beside the send it goes again without its
 *  images, then not at all: history never refuses a send. */
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
    return NO_STOPPED_HISTORY
  }
  const owed = agentSessionStoppedHistoryOwed({
    submissions: ctx.journal.submissions(),
    carried: ctx.journal.stoppedHistoryCarried(),
    clearSequence: ctx.journal.context.floor()?.sequence ?? 0,
    body: (id) => ctx.journal.itemBody(agentJournalSubmissionKey(id))
  })
  if (owed.length === 0) {
    return NO_STOPPED_HISTORY
  }
  const ids = owed.map((entry) => entry.submission.clientMessageId)
  const full = owed.map((entry) => entry.body)
  const textOnly = full.map(stoppedMessageWithoutImages)
  const tries = textOnly.some((item, index) => item !== full[index]) ? [full, textOnly] : [full]
  try {
    for (const bodies of tries) {
      const fits =
        (await ctx.adapter.historyFits?.({ sessionId: ctx.sessionId, body, history: bodies })) ??
        true
      if (fits) {
        return { ids, bodies }
      }
    }
  } catch (error) {
    ctx.logger?.warn('checking stopped history failed', {
      scope: 'stopped-history',
      sessionId: ctx.sessionId,
      error
    })
  }
  return NO_STOPPED_HISTORY
}
