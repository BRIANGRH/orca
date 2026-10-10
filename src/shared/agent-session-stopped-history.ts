// Which stopped messages the agent is still owed: a person's own sends a Stop took back before the
// agent got them, which ride as history with their next send. Derived from the journal on every
// handover, never stored; only the execution host reads it.
//
// Membership lives on the carrier's `dispatch{pending}` row (`JournalDispatchRow.carries`), and
// the carrier's own outcome says what became of it: accepted, pending or in doubt covers the
// history; refused before any write, or withdrawn with proof it was never written, leaves it owed.

import { readAgentSessionFailureFact } from './agent-session-failure'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import {
  classifyDispatchRejection,
  dispatchWasWithdrawn
} from './structured-agent-session-dispatch-rejection'

export type StoppedHistoryJournal = {
  submissions: readonly AgentJournalSubmission[]
  /** Each handed-over send's carried history, by its client message id. */
  carried: ReadonlyMap<string, readonly string[]>
  /** The latest /clear's sequence; 0 when none. */
  clearSequence: number
  body: (clientMessageId: string) => AgentJournalItemBody | null
}

/** A person's ordinary message: not a command, a goal, or mail another agent sent. */
function isOrdinaryPersonMessage(
  body: AgentJournalItemBody | null | undefined
): body is AgentJournalMessageItem {
  return (
    body?.kind === 'message' &&
    body.role === 'user' &&
    body.command === undefined &&
    body.sentAs === undefined &&
    body.from === undefined
  )
}

/** A Stop took it back with proof the agent never got it: never one the agent took into a turn. */
function withdrawnUnwritten(submission: AgentJournalSubmission): boolean {
  return (
    dispatchWasWithdrawn(submission) &&
    !submission.answeredInTurn &&
    readAgentSessionFailureFact(submission.rejection)?.mayHaveReachedAgent !== true
  )
}

/** Refused before anything reached the agent: what it carried is owed again. */
function refusedBeforeWrite(carrier: AgentJournalSubmission): boolean {
  if (carrier.dispatchState !== 'rejected' || carrier.answeredInTurn) {
    return false
  }
  const { kind } = classifyDispatchRejection(carrier)
  // A provider's own refusal may come after it recorded the input; a fact this build cannot
  // place proves nothing either.
  return (
    kind !== undefined &&
    kind !== 'providerRejected' &&
    (kind !== 'cancelled' || withdrawnUnwritten(carrier))
  )
}

/** The stopped messages owed to the agent, in the order they were sent. */
export function agentSessionStoppedHistoryOwed(
  journal: StoppedHistoryJournal
): AgentJournalSubmission[] {
  const byId = new Map(journal.submissions.map((entry) => [entry.clientMessageId, entry]))
  const covered = new Set<string>()
  for (const [carrierId, carried] of journal.carried) {
    const carrier = byId.get(carrierId)
    // A carrier rewound away took its history out of the agent's context with it.
    if (carrier && !refusedBeforeWrite(carrier)) {
      carried.forEach((id) => covered.add(id))
    }
  }
  return journal.submissions
    .filter(
      (entry) =>
        entry.acceptedSequence !== undefined &&
        entry.acceptedSequence > journal.clearSequence &&
        entry.origin === 'client' &&
        entry.source?.kind === 'user' &&
        entry.queuedMessageId === undefined &&
        !covered.has(entry.clientMessageId) &&
        withdrawnUnwritten(entry) &&
        isOrdinaryPersonMessage(journal.body(entry.clientMessageId))
    )
    .sort((left, right) => (left.acceptedSequence ?? 0) - (right.acceptedSequence ?? 0))
}

/** Whether this send may carry stopped history: a person's ordinary message (a queued card's
 *  hand-off included) that is not a slash command, which only reads right as the prompt's start. */
export function agentSessionCanCarryStoppedHistory(
  submission: Pick<AgentJournalSubmission, 'source'>,
  body: AgentJournalItemBody | null | undefined
): body is AgentJournalMessageItem {
  if (submission.source?.kind !== 'user' || !isOrdinaryPersonMessage(body)) {
    return false
  }
  const firstText = body.blocks.find((block) => block.type === 'text' && block.text.length > 0)
  return !(firstText?.type === 'text' && firstText.text.startsWith('/'))
}
