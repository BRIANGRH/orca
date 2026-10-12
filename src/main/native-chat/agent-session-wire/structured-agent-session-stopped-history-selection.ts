// What a handover writes of the stopped messages owed to the agent, chosen in the session's serialized
// handover step so a phone and a desktop sending at once write each one once: appended to the agent's
// own log ahead of the send where it can take them (Claude, Codex), else carried in the send (ACP, Pi).

import { randomUUID } from 'node:crypto'
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
import type { JournalStoppedHistory } from '../agent-session-journal/journal-stopped-message-appends'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionStoppedMessageAppendOutcome } from './structured-agent-session-stopped-history-adapter'
import type { AgentSessionPreparedDispatch } from './structured-agent-session-prepared-dispatch'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

// Preparing runs in the session's lane, so a stalled image read would hold the send, Stop and /clear.
const STOPPED_HISTORY_PREPARE_TIMEOUT_MS = 2_000

/** None for a steer into a running turn, which may never record it, or for anything but a
 *  person's ordinary send; otherwise the stopped messages owed to the agent, oldest first. */
export function owedStoppedHistory(
  ctx: {
    journal: Pick<AgentSessionJournal, 'submissions' | 'itemBody'> & {
      stoppedHistory: Pick<JournalStoppedHistory, 'carried' | 'appended'>
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
    carried: ctx.journal.stoppedHistory.carried(),
    appended: ctx.journal.stoppedHistory.appended(),
    clearSequence: ctx.journal.context.floor()?.sequence ?? 0,
    body: (id) => ctx.journal.itemBody(agentJournalSubmissionKey(id))
  })
}

type StoppedHistoryContext = {
  sessionId: string
  fence: number
  adapter: Pick<
    StructuredAgentSessionAdapter,
    'prepareDispatch' | 'stoppedMessageDelivery' | 'appendStoppedMessages'
  >
  logger: StructuredAgentSessionLogger
}

/** Appends the owed messages to the agent's own log. The record goes first and covers them, so they
 *  are never appended twice; only a proven refusal owes them again. Bookkeeping: whatever happens
 *  is logged, and the send goes on. */
export async function appendStoppedHistory(
  ctx: StoppedHistoryContext & {
    journal: Pick<AgentSessionJournal, 'liveTurnScope'> & {
      stoppedHistory: Pick<JournalStoppedHistory, 'recordAppend'>
    }
  },
  owed: readonly OwedStoppedMessage[]
): Promise<void> {
  const append = ctx.adapter.appendStoppedMessages
  if (owed.length === 0 || !append) {
    return
  }
  const appendId = randomUUID()
  const messageIds = owed.map((entry) => entry.submission.clientMessageId)
  const log = { scope: 'stopped-history', sessionId: ctx.sessionId, appendId, messageIds }
  try {
    await ctx.journal.stoppedHistory.recordAppend({ appendId, messageIds }, ctx.fence)
  } catch (error) {
    // Unrecorded, so unwritten: they stay owed.
    ctx.logger.warn('recording a stopped-message append failed', {
      ...log,
      error
    })
    return
  }
  let result: AgentSessionStoppedMessageAppendOutcome
  try {
    result = await append({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      messages: owed,
      turnLive: () => ctx.journal.liveTurnScope().kind !== 'thread'
    })
  } catch (error) {
    result = {
      outcome: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (result.outcome === 'accepted') {
    return
  }
  if (result.outcome === 'unreadable') {
    ctx.logger.warn('stopped messages had nothing left to append', log)
    return
  }
  ctx.logger.warn('appending stopped messages did not settle', {
    ...log,
    ...result
  })
  if (result.outcome === 'refused') {
    await ctx.journal.stoppedHistory
      .recordAppend({ appendId, refused: true }, ctx.fence)
      .catch((error: unknown) =>
        ctx.logger.warn('recording a refused stopped-message append failed', {
          ...log,
          error
        })
      )
  }
}

/** The send prepared once with the owed history that fits, or null to send it alone as before:
 *  none fits, the send alone fails preparation (its own refusal follows), or preparing failed or
 *  outlasted `timeoutMs`, which is logged. History never refuses or holds up a send; preparing
 *  writes nothing, so a late result is dropped and the history stays owed. */
export async function prepareStoppedHistory(
  ctx: StoppedHistoryContext,
  body: AgentJournalMessageItem,
  owed: readonly OwedStoppedMessage[],
  timeoutMs = STOPPED_HISTORY_PREPARE_TIMEOUT_MS
): Promise<AgentSessionPreparedDispatch | null> {
  const prepare = ctx.adapter.prepareDispatch
  if (owed.length === 0 || !prepare) {
    return null
  }
  const failed = (error: unknown): null => {
    ctx.logger.warn('preparing stopped history failed; the send goes alone', {
      scope: 'stopped-history',
      sessionId: ctx.sessionId,
      error
    })
    return null
  }
  const preparing = Promise.resolve()
    .then(() =>
      prepare.call(ctx.adapter, { sessionId: ctx.sessionId, fence: ctx.fence, body, owed })
    )
    .catch(failed)
  const prepared = await withTimeout<AgentSessionPreparedDispatch | null | 'timeout'>(
    preparing,
    timeoutMs,
    'timeout'
  )
  if (prepared === 'timeout') {
    return failed(new Error('preparing stopped history took too long'))
  }
  return prepared && prepared.carries.length > 0 ? prepared : null
}
