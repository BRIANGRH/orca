// The record of stopped messages appended to the agent's own log: a host-only tombstone mark that
// covers them until a later row proves the write refused, kept across replay and never published.

import { describe, expect, it } from 'vitest'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import {
  isJournalStopOrResumeRow,
  parseJournalRow,
  serializeJournalRow,
  type JournalRow,
  type JournalStoppedMessageAppend
} from './journal-row-schema'
import { buildJournalStoppedMessageAppendRow } from './journal-stopped-message-appends'

const EPOCH = 'epoch-1'

function fold(appends: JournalStoppedMessageAppend[]): {
  state: JournalReducerState
  rows: JournalRow[]
} {
  const state = createJournalReducerState('session-1', EPOCH)
  const rows = appends.map((append, index) => {
    const row = buildJournalStoppedMessageAppendRow({
      state,
      seq: index + 1,
      fence: 1,
      ts: 1,
      append
    })
    applyJournalRow(state, row)
    return row
  })
  return { state, rows }
}

describe('a stopped-message append record', () => {
  it('covers the messages it names until a refusal of the same append', () => {
    const recorded = fold([
      { appendId: 'first', messageIds: ['a', 'b'] },
      { appendId: 'second', messageIds: ['c'] }
    ])
    expect([...recorded.state.stoppedMessageAppends]).toEqual([
      ['first', ['a', 'b']],
      ['second', ['c']]
    ])

    const refused = fold([
      { appendId: 'first', messageIds: ['a', 'b'] },
      { appendId: 'second', messageIds: ['c'] },
      { appendId: 'first', refused: true }
    ])
    expect([...refused.state.stoppedMessageAppends]).toEqual([['second', ['c']]])
  })

  it('folds the same from its stored line, so it survives a restart', () => {
    const { rows } = fold([{ appendId: 'first', messageIds: ['a'] }])
    const replayed = createJournalReducerState('session-1', EPOCH)
    for (const row of rows) {
      const parsed = parseJournalRow(serializeJournalRow(row))
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        applyJournalRow(replayed, parsed.row)
      }
    }
    expect([...replayed.stoppedMessageAppends]).toEqual([['first', ['a']]])
  })

  it('is a tombstone of an id no item takes, which an older reader folds as nothing', () => {
    const { state, rows } = fold([{ appendId: 'first', messageIds: ['a'] }])
    expect(rows[0]).toMatchObject({ kind: 'tombstone', itemId: 'orca:stopped-message-append' })
    expect(isJournalStopOrResumeRow(rows[0]!)).toBe(false)
    expect(renderJournalState(state).items).toEqual([])
  })

  it('ignores a malformed record rather than the row', () => {
    const state = createJournalReducerState('session-1', EPOCH)
    const row = buildJournalStoppedMessageAppendRow({
      state,
      seq: 1,
      fence: 1,
      ts: 1,
      append: { appendId: 'first', messageIds: [] }
    })
    applyJournalRow(state, { ...row, stoppedMessageAppend: { appendId: '', messageIds: ['a'] } })
    applyJournalRow(state, row)
    expect(state.stoppedMessageAppends.size).toBe(0)
  })

  it('publishes nothing to clients', () => {
    const { state, rows } = fold([{ appendId: 'first', messageIds: ['a'] }])
    const projection = projectJournalBatch({
      rows,
      snapshot: renderJournalState(state),
      afterSequence: 0
    })
    expect(projection).toMatchObject({ ok: true, batch: { items: [], removedItemIds: [] } })
  })
})
