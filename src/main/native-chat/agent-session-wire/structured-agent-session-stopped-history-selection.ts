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
  agentSessionStoppedHistoryOwed,
  type OwedStoppedMessage
} from '../../../shared/agent-session-stopped-history'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionPreparedDispatch } from './structured-agent-session-prepared-dispatch'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** None for a steer into a running turn, which may never record it, or for anything but a
 *  person's ordinary send; otherwise the stopped messages owed to the agent, oldest first. */
export function owedStoppedHistory(
  ctx: {
    journal: Pick<AgentSessionJournal, 'submissions' | 'stoppedHistoryCarried' | 'itemBody'> & {
      context: Pick<AgentSessionJournal['context'], 'floor'>
    }
  },
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem,
  turnScope: AgentJournalTurnScope
): OwedStoppedMessage[] {
  if (turnScope.kind !== 'thread' || !agentSessionCanCarryStoppedHistory(submission, body)) {
    return []
  }
  return agentSessionStoppedHistoryOwed({
    submissions: ctx.journal.submissions(),
    carried: ctx.journal.stoppedHistoryCarried(),
    clearSequence: ctx.journal.context.floor()?.sequence ?? 0,
    body: (id) => ctx.journal.itemBody(agentJournalSubmissionKey(id))
  })
}

/** The send prepared once with the owed history that fits, or null to send it alone as before:
 *  none fits, the send alone fails preparation (its own refusal follows), or preparing failed,
 *  which is logged. History never refuses a send. */
export async function prepareStoppedHistory(
  ctx: {
    sessionId: string
    fence: number
    adapter: Pick<StructuredAgentSessionAdapter, 'prepareDispatch'>
    logger: StructuredAgentSessionLogger
  },
  body: AgentJournalMessageItem,
  owed: readonly OwedStoppedMessage[]
): Promise<AgentSessionPreparedDispatch | null> {
  if (owed.length === 0 || !ctx.adapter.prepareDispatch) {
    return null
  }
  try {
    const prepared = await ctx.adapter.prepareDispatch({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      body,
      owed
    })
    return prepared && prepared.carries.length > 0 ? prepared : null
  } catch (error) {
    ctx.logger.warn('preparing stopped history failed; the send goes alone', {
      scope: 'stopped-history',
      sessionId: ctx.sessionId,
      error
    })
    return null
  }
}
