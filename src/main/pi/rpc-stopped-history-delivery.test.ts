// A Pi send carrying stopped history writes exactly the prompt it was prepared with.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { sessionId, setup } from './rpc-session-adapter.test-support'

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function owed(id: string, text: string): OwedStoppedMessage {
  return {
    body: message(text),
    submission: {
      clientMessageId: id,
      fence: 7,
      payloadFingerprint: id,
      submittedAt: 1,
      resolvedAt: 1,
      providerItemId: null,
      handoverRecorded: true,
      acceptedSequence: 1,
      origin: 'client',
      source: { kind: 'user' },
      dispatchState: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
        { surface: 'rejection' }
      )
    }
  }
}

describe('Pi stopped history', () => {
  it('writes exactly the prepared prompt, its frame holding what the row will list', async () => {
    const h = await setup()
    const body = message('what did I send?')
    const prepared = await h.adapter.prepareDispatch({
      sessionId,
      fence: 7,
      body,
      owed: [owed('a', 'delete the build folder'), owed('b', 'then rebuild')]
    })
    expect(prepared?.carries).toEqual(['a', 'b'])
    expect(
      await h.adapter.dispatch({
        sessionId,
        fence: 7,
        clientMessageId: 'next',
        body,
        ...(prepared ? { prepared } : {})
      })
    ).toEqual({ state: 'admitted' })

    const [written] = h.connection.sent
    expect(written).toMatchObject({ type: 'prompt', images: [] })
    const text = String(written?.message)
    expect(text.match(/<stopped-message number=/g)).toHaveLength(2)
    expect(text.indexOf('delete the build folder')).toBeLessThan(text.indexOf('then rebuild'))
    expect(text.endsWith('\n\nUser message:\nwhat did I send?')).toBe(true)
  })
})
