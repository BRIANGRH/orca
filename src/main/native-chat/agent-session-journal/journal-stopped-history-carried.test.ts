// A handover row's stopped-message history: folded host-side, and an optional key an older reader
// keeps reading the row past. Nothing a client parses changes.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'

const EPOCH = 'epoch-1'

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

function submission(id: string, seq: number): JournalRow {
  return {
    kind: 'submission',
    clientMessageId: id,
    payloadFingerprint: `fp-${id}`,
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
    handoverRecorded: true,
    origin: 'client',
    source: { kind: 'user' },
    ...base(seq)
  }
}

function handover(id: string, seq: number, carries?: string[]): JournalRow {
  return {
    kind: 'dispatch',
    clientMessageId: id,
    state: 'pending',
    providerItemId: null,
    reason: null,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    ...(carries ? { carries } : {}),
    ...base(seq)
  }
}

function fold(rows: JournalRow[]): JournalReducerState {
  const state = createJournalReducerState('session-1', EPOCH)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

describe('a handover row naming the stopped messages it carries', () => {
  it('folds into host-only state, and a later handover of the same send replaces it', () => {
    const rows = [submission('a', 1), submission('c', 2), handover('c', 3, ['a'])]
    expect(fold(rows).stoppedHistoryCarried.get('c')).toEqual(['a'])
    expect(fold([...rows, handover('c', 4)]).stoppedHistoryCarried.has('c')).toBe(false)
  })

  it('drops a malformed list rather than the row', () => {
    const malformed = { ...handover('c', 3), carries: [7, '', 'a'] }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a row a damaged or newer writer could store; the fold must survive it.
    const state = fold([submission('a', 1), submission('c', 2), malformed as unknown as JournalRow])
    expect(state.stoppedHistoryCarried.get('c')).toEqual(['a'])
    expect(state.submissions.get('c')?.handedOverAt).toBeDefined()
  })

  it('reads as a readable row at the same version, so an older reader keeps the row and ignores the key', () => {
    const parsed = parseJournalRow(serializeJournalRow(handover('c', 3, ['a', 'b'])))
    expect(parsed).toMatchObject({ ok: true, row: { kind: 'dispatch', state: 'pending' } })
  })

  it('publishes nothing new: no carried list, and the never-reached mark is stripped by the client schema', () => {
    const withdrawn = agentSessionFailureWords(
      agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
      { surface: 'rejection' }
    )
    const state = fold([
      submission('a', 1),
      submission('c', 2),
      handover('c', 3, ['a']),
      {
        kind: 'dispatch',
        clientMessageId: 'a',
        state: 'rejected',
        providerItemId: null,
        reason: withdrawn.reason,
        rejection: withdrawn.rejection,
        answeredInTurn: null,
        ...base(4)
      }
    ])
    const published = renderJournalState(state).submissions
    expect(published.some((entry) => 'carries' in entry)).toBe(false)
    const stopped = published.find((entry) => entry.clientMessageId === 'a')
    expect(AgentJournalSubmissionSchema.parse(stopped).rejection).toEqual({ kind: 'cancelled' })
  })
})
