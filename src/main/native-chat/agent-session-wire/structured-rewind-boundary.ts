// Where a Codex rewind cuts the journal: the rewound turn's first row after the /clear floor. The
// retained rows and the restated append records both cut here, so they always agree.

import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'

/** A row's key as the provider names it: a send the agent accepted by the provider's own item. */
export function rewindProviderKey(
  submissions: readonly AgentJournalSubmission[]
): (itemId: string) => string {
  const keys = new Map(
    submissions.flatMap((submission) =>
      submission.dispatchState === 'accepted' && submission.providerItemId
        ? [[agentJournalSubmissionKey(submission.clientMessageId), submission.providerItemId]]
        : []
    )
  )
  return (itemId) => keys.get(itemId) ?? itemId
}

/** The index of the rewound turn's first row in `items`, in journal order, or -1 when none: the
 *  first after `floor` whose provider item names `target`'s turn on its thread, or that is its
 *  turn's record. */
export function rewindBoundaryIndex(
  items: readonly { itemId: string; sequence: number; body: AgentJournalItemBody }[],
  target: { threadId: string; turnId: string },
  floor: number,
  providerKey: (itemId: string) => string
): number {
  return items.findIndex((item) => {
    if (item.sequence <= floor) {
      return false
    }
    const identity = parseAgentJournalItemKey(providerKey(item.itemId))
    return (
      (identity?.provider === 'codex' &&
        identity.threadId === target.threadId &&
        identity.turnId === target.turnId) ||
      readAgentJournalTurn(item.body)?.turnId === target.turnId
    )
  })
}
