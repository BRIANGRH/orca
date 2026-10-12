// The host-only record of stopped messages appended to the agent's own log: tombstones of an id no
// item ever takes, carrying the append as an extra key (`journal-row-schema.ts` says why not a kind).

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import { journalRowBase } from './journal-row-builders'
import type { JournalStoppedMessageAppend, JournalTombstoneRow } from './journal-row-schema'
import type { JournalRowWriter } from './journal-row-writer'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'

const JOURNAL_STOPPED_MESSAGE_APPEND_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'stopped-message-append'
})

export function buildJournalStoppedMessageAppendRow(input: {
  state: JournalReducerState
  seq: number
  fence: number
  ts: number
  append: JournalStoppedMessageAppend
}): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: JOURNAL_STOPPED_MESSAGE_APPEND_ITEM_ID,
    revision: 1,
    stoppedMessageAppend: input.append,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

/** What the journal records of stopped messages reaching the agent, read and written. */
export class JournalStoppedHistory {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      writer: JournalRowWriter
    }
  ) {}

  /** What each handed-over send carries as stopped-message history, by its client message id. */
  carried = (): ReadonlyMap<string, readonly string[]> => this.deps.state().stoppedHistoryCarried

  /** Each append not proven refused, by append id. */
  appended = (): ReadonlyMap<string, JournalStoppedMessageAppendRecord> =>
    this.deps.state().stoppedMessageAppends

  /** An append's record, before its write, or its proven refusal. */
  recordAppend(append: JournalStoppedMessageAppend, fence: number): Promise<AgentJournalCursor> {
    return this.deps.writer.append((seq, ts) =>
      buildJournalStoppedMessageAppendRow({
        state: this.deps.state(),
        seq,
        fence,
        ts,
        append
      })
    )
  }
}

/** A standing append record: the messages it names, and its row's place, which a rewind compares
 *  with where it cuts. */
export type JournalStoppedMessageAppendRecord = {
  messageIds: readonly string[]
  sequence: number
}

/** A record covers its messages; its refusal uncovers them. A malformed one changes nothing. */
export function foldJournalStoppedMessageAppend(
  appends: Map<string, JournalStoppedMessageAppendRecord>,
  value: unknown,
  sequence: number
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('appendId' in value) ||
    typeof value.appendId !== 'string' ||
    value.appendId.length === 0
  ) {
    return
  }
  if ('refused' in value && value.refused === true) {
    appends.delete(value.appendId)
    return
  }
  const messageIds =
    'messageIds' in value && Array.isArray(value.messageIds)
      ? value.messageIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
  if (messageIds.length > 0) {
    appends.set(value.appendId, { messageIds, sequence })
  }
}
