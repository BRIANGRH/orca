// A kept append record is restated right after the row it followed, and never anywhere else: one
// anchored at the end would be dropped by a later rewind and its message appended twice.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { withRewindRestatedSends } from './structured-rewind-restated-sends'

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'stopped' }]
}

const STOPPED: AgentJournalSubmission = {
  clientMessageId: 'a',
  fence: 1,
  payloadFingerprint: 'a',
  submittedAt: 1,
  resolvedAt: 1,
  providerItemId: null,
  handoverRecorded: true,
  acceptedSequence: 10,
  origin: 'client',
  source: { kind: 'user' },
  dispatchState: 'rejected',
  ...agentSessionFailureWords(agentSessionFailureFact('cancelled', { neverReachedAgent: true }), {
    surface: 'rejection'
  })
}

function restate(recordSequence: number) {
  const logger = { warn: vi.fn() }
  const items = withRewindRestatedSends(
    [{ identity: { provider: 'orca', clientMessageId: 'a' }, body: BODY }],
    {
      submissions: () => [STOPPED],
      snapshot: () => ({
        sessionId: 'session-1',
        cursor: { epoch: 'epoch-1', sequence: 20 },
        items: [
          {
            itemId: agentJournalSubmissionKey('a'),
            revision: 1,
            body: BODY,
            sequence: 10,
            observedAt: 1
          }
        ],
        submissions: [STOPPED]
      }),
      stoppedHistory: {
        appended: () => new Map([['append-1', { messageIds: ['a'], sequence: recordSequence }]])
      },
      context: { floor: () => null }
    },
    null,
    { logger, sessionId: 'session-1' }
  )
  return { items, logger }
}

describe('restating kept append records after a rewind', () => {
  it('anchors a record right after the stopped bubble it followed', () => {
    const { items, logger } = restate(15)
    expect(items[0]?.send).toBe(STOPPED)
    expect(items[0]?.appendsAfter).toEqual([{ appendId: 'append-1', messageIds: ['a'] }])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('restates no record that no row precedes, and logs the broken order', () => {
    const { items, logger } = restate(5)
    expect(items.some((item) => item.appendsAfter !== undefined)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'a kept stopped-message append has no row before it; not restated',
      { scope: 'stopped-history', sessionId: 'session-1', appendId: 'append-1' }
    )
  })
})
