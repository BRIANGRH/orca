import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact, type SubmissionRejectionKind } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import {
  agentSessionCanCarryStoppedHistory,
  agentSessionStoppedHistoryOwed,
  type StoppedHistoryJournal
} from './agent-session-stopped-history'

function message(
  text: string,
  extra: Partial<AgentJournalMessageItem> = {}
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }],
    ...extra
  }
}

function sent(
  id: string,
  sequence: number,
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: `fp-${id}`,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: sequence,
    resolvedAt: null,
    handoverRecorded: true,
    acceptedSequence: sequence,
    origin: 'client',
    source: { kind: 'user' },
    ...extra
  }
}

function rejected(
  kind: SubmissionRejectionKind,
  extra: { neverReachedAgent?: true } = {}
): Partial<AgentJournalSubmission> {
  return {
    dispatchState: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact(kind, extra), {
      surface: 'rejection'
    })
  }
}

/** A Stop's withdrawal with proof the agent never got it. */
const STOPPED = rejected('cancelled', { neverReachedAgent: true })

function owed(
  submissions: AgentJournalSubmission[],
  options: {
    carried?: Record<string, string[]>
    clearSequence?: number
    bodies?: Record<string, AgentJournalItemBody>
  } = {}
): string[] {
  const journal: StoppedHistoryJournal = {
    submissions,
    carried: new Map(Object.entries(options.carried ?? {})),
    clearSequence: options.clearSequence ?? 0,
    body: (id) => options.bodies?.[id] ?? message(id)
  }
  return agentSessionStoppedHistoryOwed(journal).map((entry) => entry.submission.clientMessageId)
}

describe('which stopped messages the agent is owed', () => {
  it("owes a person's own sends a Stop took back unwritten, in the order they were sent", () => {
    expect(owed([sent('b', 5, STOPPED), sent('a', 2, STOPPED), sent('live', 7)])).toEqual([
      'a',
      'b'
    ])
  })

  it('never owes a withdrawal without proof it never reached the agent, as old journals hold', () => {
    expect(owed([sent('a', 2, rejected('cancelled'))])).toEqual([])
  })

  it('never owes a send in doubt, such as one Claude had started when Stop cancelled it', () => {
    expect(owed([sent('a', 2, { dispatchState: 'unknown', reason: 'doubt' })])).toEqual([])
  })

  it('never owes mail, a task preamble, a queued card, a command, a goal or a typed slash command', () => {
    const bodies: Record<string, AgentJournalItemBody> = {
      command: message('/compact', { command: { name: 'compact' } }),
      goal: message('ship it', { sentAs: 'goal' }),
      mail: message('mail', {
        from: { kind: 'agent', senders: [], orchestration: null }
      })
    }
    expect(
      owed(
        [
          sent('mail', 1, { ...STOPPED, source: { kind: 'agent' } }),
          sent('mailBody', 2, STOPPED),
          sent('preamble', 3, {
            ...STOPPED,
            source: undefined,
            origin: 'host'
          }),
          sent('card', 4, { ...STOPPED, queuedMessageId: 'card' }),
          sent('command', 5, STOPPED),
          sent('goal', 6, STOPPED),
          sent('slash', 7, STOPPED)
        ],
        { bodies: { ...bodies, mailBody: bodies.mail!, slash: message('/review foo') } }
      )
    ).toEqual([])
  })

  it('owes nothing from before the latest /clear', () => {
    expect(
      owed([sent('old', 2, STOPPED), sent('new', 9, STOPPED)], {
        clearSequence: 5
      })
    ).toEqual(['new'])
  })

  it('a carrier accepted, pending, in doubt or refused after a possible write covers what it carried', () => {
    for (const carrier of [
      sent('c', 9, { dispatchState: 'accepted' }),
      sent('c', 9),
      sent('c', 9, {
        dispatchState: 'unknown',
        reason: 'lost',
        recovered: true
      }),
      sent('c', 9, rejected('providerRejected')),
      sent('c', 9, rejected('notSignedIn')),
      sent('c', 9, rejected('providerExited')),
      sent('c', 9, rejected('hostFault')),
      sent('c', 9, rejected('cancelled')),
      sent('c', 9, {
        ...STOPPED,
        answeredInTurn: { turnItemId: 'turn', via: 'start' }
      })
    ]) {
      expect(owed([sent('a', 2, STOPPED), carrier], { carried: { c: ['a'] } })).toEqual([])
    }
  })

  it('a carrier refused before any write leaves what it carried owed again', () => {
    for (const kind of [
      'queueFull',
      'writeFailed',
      'attachmentInvalid',
      'attachmentUnreadable',
      'emptyMessage'
    ] as const) {
      expect(
        owed([sent('a', 2, STOPPED), sent('c', 9, rejected(kind))], {
          carried: { c: ['a'] }
        })
      ).toEqual(['a'])
    }
  })

  it('any carrier refused with proof it never reached the agent leaves what it carried owed', () => {
    // Pi's sign-in check runs before it records a prompt; ACP's encoder refuses before any byte.
    for (const kind of ['notSignedIn', 'writeFailed', 'providerRejected'] as const) {
      expect(
        owed([sent('a', 2, STOPPED), sent('c', 9, rejected(kind, { neverReachedAgent: true }))], {
          carried: { c: ['a'] }
        })
      ).toEqual(['a'])
    }
  })

  it('a carrier a Stop withdrew unwritten flattens with what it carried, in send order', () => {
    expect(
      owed([sent('a', 2, STOPPED), sent('b', 3, STOPPED), sent('c', 9, STOPPED)], {
        carried: { c: ['a', 'b'] }
      })
    ).toEqual(['a', 'b', 'c'])
  })

  it('any covering carrier covers, though an earlier one was refused', () => {
    expect(
      owed(
        [
          sent('a', 2, STOPPED),
          sent('c1', 5, rejected('writeFailed')),
          sent('c2', 9, { dispatchState: 'accepted' })
        ],
        { carried: { c1: ['a'], c2: ['a'] } }
      )
    ).toEqual([])
  })

  it('a carrier rewound away no longer covers: the rewind took its history out of context too', () => {
    expect(owed([sent('a', 2, STOPPED)], { carried: { gone: ['a'] } })).toEqual(['a'])
  })
})

describe('which sends carry stopped history', () => {
  const user = { source: { kind: 'user' } }

  it("a person's ordinary send carries it, a queued card's hand-off too", () => {
    expect(agentSessionCanCarryStoppedHistory(user, message('next'))).toBe(true)
    expect(agentSessionCanCarryStoppedHistory({ queuedMessageId: 'card' }, message('card'))).toBe(
      true
    )
  })

  it('a slash command, a command, mail or an orchestration preamble does not', () => {
    expect(agentSessionCanCarryStoppedHistory(user, message('/review'))).toBe(false)
    expect(
      agentSessionCanCarryStoppedHistory(
        user,
        message('/compact', { command: { name: 'compact' } })
      )
    ).toBe(false)
    expect(agentSessionCanCarryStoppedHistory({ source: { kind: 'agent' } }, message('mail'))).toBe(
      false
    )
    expect(agentSessionCanCarryStoppedHistory({}, message('preamble'))).toBe(false)
    const mail = message('task', { from: { kind: 'agent', senders: [], orchestration: null } })
    expect(agentSessionCanCarryStoppedHistory({ queuedMessageId: 'card' }, mail)).toBe(false)
  })
})
