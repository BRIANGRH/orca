// A rewind restates a stopped send with the rows that first recorded it: its rejection through the
// one dispatch-row builder, with the words as stored.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { journalRestatedSendRows } from './journal-rewind-restated-send-rows'

describe('restating a stopped send after a rewind', () => {
  it('writes its rejection as first stored: the agent-named words, the fact, its kept draft', () => {
    const words = agentSessionFailureWords(
      agentSessionFailureFact('providerExited', { neverReachedAgent: true }),
      { surface: 'rejection', agentName: 'Codex' }
    )
    const stored: AgentJournalSubmission = {
      clientMessageId: 'a',
      fence: 1,
      payloadFingerprint: 'fingerprint-a',
      submittedAt: 1,
      resolvedAt: 1,
      providerItemId: null,
      handoverRecorded: true,
      acceptedSequence: 1,
      origin: 'client',
      source: { kind: 'user' },
      dispatchState: 'rejected',
      keptAsQueuedMessageId: 'draft-1',
      ...words
    }
    const state = createJournalReducerState('session-1', 'epoch-2')
    const rows = journalRestatedSendRows({
      state,
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      fence: 3,
      item: {
        identity: { provider: 'orca', clientMessageId: 'a' },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'stopped' }] },
        send: stored
      }
    })
    rows.forEach((row, index) => applyJournalRow(state, row(index + 1, 100 + index)))

    expect(words.reason).toContain('Codex')
    expect(renderJournalState(state).submissions).toEqual([
      expect.objectContaining({
        clientMessageId: 'a',
        dispatchState: 'rejected',
        reason: words.reason,
        rejection: words.rejection,
        keptAsQueuedMessageId: 'draft-1',
        handoverRecorded: true
      })
    ])
  })
})
