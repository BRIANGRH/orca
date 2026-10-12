// Stopped messages the agent is still owed, derived from the journal on each handover (host only).
// One is covered by an append record that no later row proves refused (Claude, Codex), or by an
// ACP or Pi carrier's `carries` unless that carrier was refused before anything reached the agent.

import { readAgentSessionFailureFact, type SubmissionRejectionKind } from './agent-session-failure'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import {
  classifyDispatchRejection,
  dispatchWasWithdrawn
} from './structured-agent-session-dispatch-rejection'

/** The record Claude writes for its own Stop: written after each stopped message appended to
 *  Claude's log, and carried after each one in an ACP or Pi send. */
export const STOPPED_MESSAGE_INTERRUPTED_MARKER = '[Request interrupted by user]'

export type StoppedHistoryJournal = {
  submissions: readonly AgentJournalSubmission[]
  /** Each handed-over send's carried history, by its client message id. */
  carried: ReadonlyMap<string, readonly string[]>
  /** Each append not proven refused, by append id. */
  appended: ReadonlyMap<string, { readonly messageIds: readonly string[] }>
  /** The latest /clear's sequence; 0 when none. */
  clearSequence: number
  body: (clientMessageId: string) => AgentJournalItemBody | null
}

export type OwedStoppedMessage = {
  submission: AgentJournalSubmission
  body: AgentJournalMessageItem
}

/** A person's ordinary message: not a command, a goal, mail another agent sent, or a typed slash
 *  command, which only reads right as the start of a prompt. */
function isOrdinaryPersonMessage(
  body: AgentJournalItemBody | null | undefined
): body is AgentJournalMessageItem {
  if (
    body?.kind !== 'message' ||
    body.role !== 'user' ||
    body.command !== undefined ||
    body.sentAs !== undefined ||
    body.from !== undefined
  ) {
    return false
  }
  const firstText = body.blocks.find((block) => block.type === 'text' && block.text.length > 0)
  return !(firstText?.type === 'text' && firstText.text.startsWith('/'))
}

/** A Stop took it back where Orca proves the agent never received it. */
function withdrawnUnwritten(submission: AgentJournalSubmission): boolean {
  return (
    dispatchWasWithdrawn(submission) &&
    !submission.answeredInTurn &&
    readAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true
  )
}

// Raised by Orca before any byte reached the agent; any other kind may follow a provider write.
const REFUSED_BEFORE_WRITE: ReadonlySet<SubmissionRejectionKind> = new Set([
  'queueFull',
  'writeFailed',
  'attachmentInvalid',
  'attachmentUnreadable',
  'emptyMessage'
])

/** Refused before anything reached the agent: what it carried is owed again. */
function refusedBeforeWrite(carrier: AgentJournalSubmission): boolean {
  if (carrier.dispatchState !== 'rejected' || carrier.answeredInTurn) {
    return false
  }
  // Proven unwritten where it was refused: a Stop's withdrawal, a write Orca's encoder refused, or
  // a sign-in Pi checks before recording the prompt.
  if (readAgentSessionFailureFact(carrier.rejection)?.neverReachedAgent === true) {
    return true
  }
  const { kind } = classifyDispatchRejection(carrier)
  return kind !== undefined && REFUSED_BEFORE_WRITE.has(kind)
}

/** The stopped messages owed to the agent, in the order they were sent. */
export function agentSessionStoppedHistoryOwed(
  journal: StoppedHistoryJournal
): OwedStoppedMessage[] {
  const byId = new Map(journal.submissions.map((entry) => [entry.clientMessageId, entry]))
  const covered = new Set([...journal.appended.values()].flatMap((append) => append.messageIds))
  for (const [carrierId, carried] of journal.carried) {
    const carrier = byId.get(carrierId)
    if (carrier && !refusedBeforeWrite(carrier)) {
      carried.forEach((id) => covered.add(id))
    }
  }
  return journal.submissions
    .flatMap((submission) => {
      if (
        submission.acceptedSequence === undefined ||
        submission.acceptedSequence <= journal.clearSequence ||
        submission.origin !== 'client' ||
        submission.source?.kind !== 'user' ||
        submission.queuedMessageId !== undefined ||
        covered.has(submission.clientMessageId) ||
        !withdrawnUnwritten(submission)
      ) {
        return []
      }
      const body = journal.body(submission.clientMessageId)
      return isOrdinaryPersonMessage(body) ? [{ submission, body }] : []
    })
    .sort(
      (left, right) =>
        (left.submission.acceptedSequence ?? 0) - (right.submission.acceptedSequence ?? 0)
    )
}

/** Whether this send's handover delivers the stopped messages owed, appended or carried: a person's
 *  ordinary message, a queued card's hand-off included. */
export function agentSessionSendDeliversStoppedHistory(
  submission: Pick<AgentJournalSubmission, 'source' | 'queuedMessageId'>,
  body: AgentJournalItemBody | null | undefined
): body is AgentJournalMessageItem {
  // A card's hand-off records no sender; its body's missing `from` says it is the person's.
  const persons = submission.source?.kind === 'user' || submission.queuedMessageId !== undefined
  return persons && isOrdinaryPersonMessage(body)
}
