// The handover's choice of stopped history: bounded by the latest /clear, never on a steer, appended
// with its record written first or prepared once by the adapter, and never a reason a send fails.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  appendStoppedHistory,
  owedStoppedHistory,
  prepareStoppedHistory
} from './structured-agent-session-stopped-history-selection'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { JournalStoppedMessageAppend } from '../agent-session-journal/journal-row-schema'

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

function journal(options: {
  clearSequence?: number
  appended?: Map<string, { messageIds: readonly string[]; sequence: number }>
}): Parameters<typeof owedStoppedHistory>[0] {
  const submissions = [stopped('old', 2), stopped('new', 9), CARRIER]
  return {
    journal: {
      submissions: () => submissions,
      stoppedHistory: {
        carried: () => new Map(),
        appended: () => options.appended ?? new Map()
      },
      context: {
        floor: () =>
          options.clearSequence ? { epoch: 'epoch-1', sequence: options.clearSequence } : null
      },
      itemBody: (itemId) =>
        message(
          submissions.find((entry) => agentJournalSubmissionKey(entry.clientMessageId) === itemId)!
            .clientMessageId
        )
    }
  }
}

function owedIds(...args: Parameters<typeof owedStoppedHistory>): string[] {
  return owedStoppedHistory(...args).map((entry) => entry.submission.clientMessageId)
}

function preparing(prepareDispatch?: StructuredAgentSessionAdapter['prepareDispatch']) {
  return {
    sessionId: 'session-1',
    fence: 1,
    adapter: prepareDispatch ? { prepareDispatch } : {},
    logger: { warn: vi.fn(), error: vi.fn() }
  }
}

const OWED = owedStoppedHistory(journal({}), CARRIER, message('next'), AGENT_JOURNAL_THREAD_SCOPE)

describe('choosing the stopped history a handover carries', () => {
  it('owes only what was sent after the latest /clear, oldest first', () => {
    expect(owedIds(journal({}), CARRIER, message('next'), AGENT_JOURNAL_THREAD_SCOPE)).toEqual([
      'old',
      'new'
    ])
    expect(
      owedIds(journal({ clearSequence: 5 }), CARRIER, message('next'), AGENT_JOURNAL_THREAD_SCOPE)
    ).toEqual(['new'])
  })

  it('carries nothing on a steer into a running turn, which may never record it', () => {
    expect(
      owedIds(journal({}), CARRIER, message('next'), { kind: 'turn', turnItemId: 'turn-1' })
    ).toEqual([])
  })

  it('a slash command carries nothing', () => {
    expect(owedIds(journal({}), CARRIER, message('/review'), AGENT_JOURNAL_THREAD_SCOPE)).toEqual(
      []
    )
  })

  it('asks the adapter once, with every owed message, and takes its prepared send as is', async () => {
    const prepared = { carries: ['old'] }
    const prepare = vi.fn(async () => prepared)
    expect(await prepareStoppedHistory(preparing(prepare), message('next'), OWED)).toBe(prepared)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fence: 1,
      body: message('next'),
      owed: OWED
    })
  })

  it('prepares nothing when nothing is owed, so a plain send goes as it always did', async () => {
    const prepare = vi.fn(async () => ({ carries: ['old'] }))
    expect(await prepareStoppedHistory(preparing(prepare), message('next'), [])).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('sends alone when none fits or the agent cannot carry history', async () => {
    expect(
      await prepareStoppedHistory(
        preparing(async () => null),
        message('next'),
        OWED
      )
    ).toBeNull()
    expect(
      await prepareStoppedHistory(
        preparing(async () => ({ carries: [] })),
        message('next'),
        OWED
      )
    ).toBeNull()
    expect(await prepareStoppedHistory(preparing(), message('next'), OWED)).toBeNull()
  })

  it('a failed preparation sends the message alone, logged, and leaves the history owed', async () => {
    const ctx = preparing(async () => {
      throw new Error('stat failed')
    })
    expect(await prepareStoppedHistory(ctx, message('next'), OWED)).toBeNull()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('owes nothing an append record names', () => {
    expect(
      owedIds(
        journal({ appended: new Map([['append-1', { messageIds: ['old'], sequence: 1 }]]) }),
        CARRIER,
        message('next'),
        AGENT_JOURNAL_THREAD_SCOPE
      )
    ).toEqual(['new'])
  })
})

describe('appending the stopped messages owed to the agent', () => {
  function appending(
    append: NonNullable<StructuredAgentSessionAdapter['appendStoppedMessages']>,
    record: (append: JournalStoppedMessageAppend) => Promise<void> = async () => {}
  ) {
    const events: string[] = []
    const ctx = {
      sessionId: 'session-1',
      fence: 1,
      adapter: {
        appendStoppedMessages: vi.fn(async (input: Parameters<typeof append>[0]) => {
          events.push(
            `append ${input.messages.map((entry) => entry.submission.clientMessageId).join(',')}`
          )
          return append(input)
        })
      },
      journal: {
        liveTurnScope: vi.fn((): AgentJournalTurnScope => AGENT_JOURNAL_THREAD_SCOPE),
        stoppedHistory: {
          recordAppend: vi.fn(async (entry: JournalStoppedMessageAppend) => {
            events.push(
              'refused' in entry ? 'record refused' : `record ${entry.messageIds.join(',')}`
            )
            await record(entry)
            return { epoch: 'epoch-1', sequence: 1 }
          })
        }
      },
      logger: { warn: vi.fn(), error: vi.fn() }
    }
    return { ctx, events }
  }

  it('records the append before writing it, and records nothing more when the agent took it', async () => {
    const { ctx, events } = appending(async () => ({ outcome: 'accepted' }))
    await appendStoppedHistory(ctx, OWED)

    expect(events).toEqual(['record old,new', 'append old,new'])
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('records a proven refusal, so they are owed again', async () => {
    const { ctx, events } = appending(async () => ({
      outcome: 'refused',
      reason: 'Codex is running a turn'
    }))
    await appendStoppedHistory(ctx, OWED)

    expect(events).toEqual(['record old,new', 'append old,new', 'record refused'])
  })

  it('leaves an unknown or thrown append covered, never to be appended again', async () => {
    for (const append of [
      async () => ({ outcome: 'unknown' as const, reason: 'timed out' }),
      async () => {
        throw new Error('lost contact')
      }
    ]) {
      const { ctx, events } = appending(append)
      await appendStoppedHistory(ctx, OWED)

      expect(events).toEqual(['record old,new', 'append old,new'])
      expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    }
  })

  it('writes nothing to the agent when the record cannot be written, so they stay owed', async () => {
    const { ctx, events } = appending(
      async () => ({ outcome: 'accepted' }),
      async () => {
        throw new Error('disk full')
      }
    )
    await appendStoppedHistory(ctx, OWED)

    expect(events).toEqual(['record old,new'])
    expect(ctx.adapter.appendStoppedMessages).not.toHaveBeenCalled()
  })

  it("lets the agent read Orca's turn right before its write", async () => {
    const live: boolean[] = []
    const { ctx } = appending(async ({ turnLive }) => {
      live.push(turnLive())
      ctx.journal.liveTurnScope.mockReturnValue({ kind: 'turn', turnItemId: 'turn-1' })
      live.push(turnLive())
      return { outcome: 'refused', reason: 'Codex is running a turn' }
    })
    await appendStoppedHistory(ctx, OWED)

    expect(live).toEqual([false, true])
  })

  it('logs a message with nothing left to append once, as nothing written, and leaves it covered', async () => {
    const { ctx, events } = appending(async () => ({ outcome: 'unreadable' }))
    await appendStoppedHistory(ctx, OWED)

    expect(events).toEqual(['record old,new', 'append old,new'])
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'stopped messages had nothing left to append',
      expect.not.objectContaining({ outcome: 'unknown' })
    )
  })

  it('appends nothing when nothing is owed', async () => {
    const { ctx, events } = appending(async () => ({ outcome: 'accepted' }))
    await appendStoppedHistory(ctx, [])

    expect(events).toEqual([])
  })
})
