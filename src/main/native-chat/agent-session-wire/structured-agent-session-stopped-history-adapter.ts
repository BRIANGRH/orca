// How an adapter takes stopped messages owed to its agent: appended to the agent's own log where the
// agent can record a message without running it, else carried in the person's next send.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../../shared/agent-session-stopped-history'
import type { AgentSessionPreparedDispatch } from './structured-agent-session-prepared-dispatch'

/** `refused`: proven before anything reached the agent, so they are owed again. `unknown`: they may
 *  be in its log, so they are never appended again. `unreadable`: nothing in them still reads, so
 *  nothing was written, and they are never tried again, as a send drops what no longer reads. */
export type AgentSessionStoppedMessageAppendOutcome =
  | { outcome: 'accepted' | 'unreadable' }
  | { outcome: 'refused' | 'unknown'; reason: string }

/** `append`: `appendStoppedMessages`; `carry`: `prepareDispatch`; `none`: neither, or not now. */
export type AgentSessionStoppedMessageDelivery = 'append' | 'carry' | 'none'

export type StructuredAgentSessionStoppedHistoryAdapter = {
  /** How this session's agent takes the stopped messages owed to it now; absent: `none`. An agent
   *  that appends answers `none` while it cannot take one, read cheaply before anything is
   *  recorded, so a busy agent leaves them owed with no row written. */
  stoppedMessageDelivery?(sessionId: string): AgentSessionStoppedMessageDelivery
  /** Prepares a person's send once with the stopped messages it can carry within this agent's
   *  limits, before the handover is recorded. Null when none rides or the send alone fails to
   *  prepare. */
  prepareDispatch?(input: {
    sessionId: string
    fence: number
    body: AgentJournalMessageItem
    owed: readonly OwedStoppedMessage[]
    /** Aborted once the handover stops waiting: no further stopped image is read. */
    signal?: AbortSignal
  }): Promise<AgentSessionPreparedDispatch | null>
  /** Writes stopped messages into the agent's own log, each followed by the agent's own record of
   *  an interrupted request, without running a turn; oldest first, in one write. Refused when,
   *  right before the write, `fence` is no longer the child's or `turnLive` says Orca opened a
   *  turn. Settles within a few seconds. */
  appendStoppedMessages?(input: {
    sessionId: string
    fence: number
    messages: readonly OwedStoppedMessage[]
    turnLive: () => boolean
  }): Promise<AgentSessionStoppedMessageAppendOutcome>
}
