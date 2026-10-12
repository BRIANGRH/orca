// How an adapter takes stopped messages owed to its agent: appended to the agent's own log where the
// agent can record a message without running it, else carried in the person's next send.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../../shared/agent-session-stopped-history'
import type { AgentSessionPreparedDispatch } from './structured-agent-session-prepared-dispatch'

/** `refused`: proven before anything reached the agent, so they are owed again. `unknown`: they may
 *  be in its log, so they are never appended again. */
export type AgentSessionStoppedMessageAppendOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'refused' | 'unknown'; reason: string }

export type StructuredAgentSessionStoppedHistoryAdapter = {
  /** Prepares a person's send once with the stopped messages it can carry within this agent's
   *  limits, before the handover is recorded. Null when none rides or the send alone fails to
   *  prepare. Only for an agent that cannot append them (`appendStoppedMessages`). */
  prepareDispatch?(input: {
    sessionId: string
    fence: number
    body: AgentJournalMessageItem
    owed: readonly OwedStoppedMessage[]
  }): Promise<AgentSessionPreparedDispatch | null>
  /** Whether this session's agent appends stopped messages rather than carrying them; absent:
   *  whether this adapter has `appendStoppedMessages`. */
  appendsStoppedMessages?(sessionId: string): boolean
  /** Writes stopped messages into the agent's own log, each followed by the agent's own record of
   *  an interrupted request, without running a turn; oldest first, in one write. Settles within a
   *  few seconds. */
  appendStoppedMessages?(input: {
    sessionId: string
    fence: number
    messages: readonly OwedStoppedMessage[]
  }): Promise<AgentSessionStoppedMessageAppendOutcome>
}
