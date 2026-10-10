// The handover's choice of stopped history: bounded by the latest /clear, never on a steer, oldest
// first with each message's images left out only when that message needs it, and never a reason a
// send waits or fails.

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

const WITH_IMAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [
    { type: 'image-ref', path: '/tmp/shot.png' },
    { type: 'text', text: 'new' }
  ]
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
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled', { neverReachedAgent: true }), {
      surface: 'rejection'
    })
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
  historyFits?: (input: { history: readonly AgentJournalMessageItem[] }) => Promise<boolean>
  bodies?: Record<string, AgentJournalMessageItem>
  /** The stopped messages, oldest first; sequences 2, 9, then 12 on. */
  stoppedIds?: readonly string[]
}): Parameters<typeof selectStoppedHistory>[0] {
  const submissions = [
    ...(options.stoppedIds ?? ['old', 'new']).map((id, index) =>
      stopped(id, index === 0 ? 2 : index === 1 ? 9 : 10 + index)
    ),
    CARRIER
  ]
  return {
    sessionId: 'session-1',
    journal: {
      submissions: () => submissions,
      stoppedHistoryCarried: () => new Map(),
      context: {
        floor: () =>
          options.clearSequence ? { epoch: 'epoch-1', sequence: options.clearSequence } : null
      },
      itemBody: (itemId) => {
        const id = submissions.find(
          (entry) => agentJournalSubmissionKey(entry.clientMessageId) === itemId
        )!.clientMessageId
        return options.bodies?.[id] ?? message(id)
      }
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

  it('leaves images out only for the message that needed it', async () => {
    const atMostOneImage = async (input: { history: readonly AgentJournalMessageItem[] }) =>
      input.history.flatMap((item) => item.blocks).filter((block) => block.type === 'image-ref')
        .length <= 1
    const chosen = await selectStoppedHistory(
      context({
        historyFits: atMostOneImage,
        stoppedIds: ['first', 'second'],
        bodies: { first: WITH_IMAGE, second: WITH_IMAGE }
      }),
      CARRIER,
      message('next'),
      AGENT_JOURNAL_THREAD_SCOPE
    )
    expect(chosen.ids).toEqual(['first', 'second'])
    expect(chosen.bodies[0]).toBe(WITH_IMAGE)
    expect(chosen.bodies[1]?.blocks).toEqual([
      { type: 'text', text: 'It had 1 image(s), not attached.' },
      { type: 'text', text: 'new' }
    ])
  })

  it('skips a message too large to ride this time and still carries the later ones', async () => {
    const shortText = async (input: { history: readonly AgentJournalMessageItem[] }) =>
      input.history
        .flatMap((item) => item.blocks)
        .reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0) <= 50
    const chosen = await selectStoppedHistory(
      context({
        historyFits: shortText,
        stoppedIds: ['old', 'huge', 'new'],
        bodies: { huge: message('x'.repeat(100)) }
      }),
      CARRIER,
      message('next'),
      AGENT_JOURNAL_THREAD_SCOPE
    )
    expect(chosen.ids).toEqual(['old', 'new'])
  })

  it('sends alone when nothing fits, asking twice only for a message with images', async () => {
    const never = vi.fn(async () => false)
    const alone = await selectStoppedHistory(
      context({ historyFits: never, bodies: { new: WITH_IMAGE } }),
      CARRIER,
      message('next'),
      AGENT_JOURNAL_THREAD_SCOPE
    )
    expect(alone).toEqual({ ids: [], bodies: [] })
    expect(never).toHaveBeenCalledTimes(3)
  })
})
