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

/** Logs a send going without the stopped history it was to carry, then tells the host, which stops
 *  listing that history as carried before the write. */
export function stoppedHistoryLeftOut(
  logger: StructuredAgentSessionLogger | undefined,
  input: { sessionId?: string; historyLeftOut?: () => Promise<void> }
): (error: unknown) => Promise<void> {
  return async (error) => {
    logger?.warn('stopped history left out of a send', {
      scope: 'stopped-history',
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      error
    })
    await input.historyLeftOut?.()
  }
}

/** The adapter is sending without the history this send's pending row lists: rewrite the row
 *  without it, so those messages stay owed. A failed write is logged and the send still goes. */
export async function uncarryStoppedHistory(
  ctx: {
    sessionId: string
    fence: number
    journal: Pick<AgentSessionJournal, 'submission' | 'resolveDispatch'>
    logger: StructuredAgentSessionLogger
  },
  clientMessageId: string,
  turnScope: AgentJournalTurnScope
): Promise<void> {
  try {
    if (ctx.journal.submission(clientMessageId)?.dispatchState === 'pending') {
      await ctx.journal.resolveDispatch({
        clientMessageId,
        state: 'pending',
        fence: ctx.fence,
        turnScope
      })
    }
  } catch (error) {
    ctx.logger.warn('un-listing stopped history left out of a send failed', {
      scope: 'stopped-history',
      sessionId: ctx.sessionId,
      error
    })
  }
}

/** None for a steer into a running turn, which may never record it, or for anything but a
 *  person's ordinary send. Oldest first, each stopped message rides with its images if the whole
 *  still fits, else without them, else waits for a later send without holding back the rest:
 *  history never refuses a send. */
export async function selectStoppedHistory(
  ctx: {
    sessionId: string
    journal: Pick<AgentSessionJournal, 'submissions' | 'stoppedHistoryCarried' | 'itemBody'> & {
      context: Pick<AgentSessionJournal['context'], 'floor'>
    }
    adapter: Pick<StructuredAgentSessionAdapter, 'historyFits'>
    logger: StructuredAgentSessionLogger
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
  const selected: StoppedHistorySelection = { ids: [], bodies: [] }
  try {
    for (const entry of owed) {
      const textOnly = stoppedMessageWithoutImages(entry.body)
      for (const candidate of textOnly === entry.body ? [entry.body] : [entry.body, textOnly]) {
        const history = [...selected.bodies, candidate]
        if (
          (await ctx.adapter.historyFits?.({ sessionId: ctx.sessionId, body, history })) ??
          true
        ) {
          selected.ids.push(entry.submission.clientMessageId)
          selected.bodies.push(candidate)
          break
        }
      }
    }
  } catch (error) {
    ctx.logger.warn('checking stopped history failed', {
      scope: 'stopped-history',
      sessionId: ctx.sessionId,
      error
    })
    return NO_STOPPED_HISTORY
  }
  return selected
}
