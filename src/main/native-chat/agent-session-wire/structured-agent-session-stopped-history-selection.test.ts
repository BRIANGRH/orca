// The handover's choice of stopped history: bounded by the latest /clear, never on a steer, and
// never a reason a send waits or fails.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { selectStoppedHistory } from './structured-agent-session-stopped-history-selection'

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function stopped(id: string, sequence: number): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    submittedAt: sequence,
    resolvedAt: sequence,
    providerItemId: null,
    handoverRecorded: true,
    acceptedSequence: sequence,
    origin: 'client',
    source: { kind: 'user' },
    dispatchState: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  }
}

const CARRIER: AgentJournalSubmission = {
  ...stopped('next', 20),
  dispatchState: 'pending',
  reason: null,
  rejection: undefined
}

function context(options: {
  clearSequence?: number
  historyFits?: () => Promise<boolean>
}): Parameters<typeof selectStoppedHistory>[0] {
  const submissions = [stopped('old', 2), stopped('new', 9), CARRIER]
  return {
    sessionId: 'session-1',
    journal: {
      submissions: () => submissions,
      stoppedHistoryCarried: () => new Map(),
      context: {
        floor: () =>
          options.clearSequence ? { epoch: 'epoch-1', sequence: options.clearSequence } : null
      },
      itemBody: (itemId) =>
        message(
          submissions.find((entry) => agentJournalSubmissionKey(entry.clientMessageId) === itemId)!
            .clientMessageId
        )
    },
    adapter: options.historyFits ? { historyFits: options.historyFits } : {},
    logger: { warn: vi.fn(), error: vi.fn() }
  }
}

describe('choosing the stopped history a handover carries', () => {
  it('carries only what was sent after the latest /clear', async () => {
    const chosen = await selectStoppedHistory(
      context({ clearSequence: 5 }),
      CARRIER,
      message('next'),
      AGENT_JOURNAL_THREAD_SCOPE
    )
    expect(chosen.ids).toEqual(['new'])
  })

  it('carries nothing on a steer into a running turn, which may never record it', async () => {
    const chosen = await selectStoppedHistory(context({}), CARRIER, message('next'), {
      kind: 'turn',
      turnItemId: 'turn-1'
    })
    expect(chosen.ids).toEqual([])
  })

  it('a failed fit check sends the message alone and leaves the history owed', async () => {
    const chosen = await selectStoppedHistory(
      context({
        historyFits: async () => {
          throw new Error('stat failed')
        }
      }),
      CARRIER,
      message('next'),
      AGENT_JOURNAL_THREAD_SCOPE
    )
    expect(chosen).toEqual({ ids: [], bodies: [] })
  })
})
