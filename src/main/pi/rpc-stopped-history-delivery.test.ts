// A Pi send carrying stopped history writes exactly the prompt it was prepared with.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  agentSessionStoppedHistoryOwed,
  type OwedStoppedMessage
} from '../../shared/agent-session-stopped-history'
import { encodeNdjson } from '../../shared/main-process-ndjson-framer'
import { resolveJsonlRpcPeerOptions } from '../jsonl-rpc/peer-limits'
import { sessionId, setup } from './rpc-session-adapter.test-support'

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function owed(id: string, text: string, acceptedSequence = 1): OwedStoppedMessage {
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
      acceptedSequence,
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

  it('fits the history beside the frame Pi is written, which the line encoder admits', async () => {
    const h = await setup()
    const maxLineBytes = resolveJsonlRpcPeerOptions().maxLineBytes
    const lines: string[] = []
    vi.spyOn(h.connection, 'send').mockImplementation(async (frame) => {
      lines.push(encodeNdjson(frame, maxLineBytes))
    })
    const body = message('x'.repeat(maxLineBytes - 30_000))
    const prepared = await h.adapter.prepareDispatch({
      sessionId,
      fence: 7,
      body,
      owed: [owed('a', 'a'.repeat(40_000)), owed('b', 'then rebuild', 2)]
    })
    expect(prepared?.carries).toEqual(['a'])

    expect(
      await h.adapter.dispatch({
        sessionId,
        fence: 7,
        clientMessageId: 'next',
        body,
        ...(prepared ? { prepared } : {})
      })
    ).toEqual({ state: 'admitted' })
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(Buffer.byteLength(line) - 1).toBeLessThanOrEqual(maxLineBytes)
    const written = JSON.parse(line)
    expect(written.streamingBehavior).toBe('followUp')
    expect(written.message.match(/<stopped-message number=/g)).toHaveLength(1)
    expect(written.message).toContain('shortened="true"')
    expect(written.message).not.toContain('then rebuild')
  })

  it('owes the history again when the line encoder refuses its carrier', async () => {
    const h = await setup()
    vi.spyOn(h.connection, 'send').mockImplementationOnce(async (frame) => {
      encodeNdjson(frame, 16)
    })
    const stopped = [owed('a', 'delete the build folder'), owed('b', 'then rebuild', 2)]
    const body = message('what did I send?')
    const prepared = await h.adapter.prepareDispatch({ sessionId, fence: 7, body, owed: stopped })
    expect(prepared?.carries).toEqual(['a', 'b'])

    const outcome = await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'next',
      body,
      ...(prepared ? { prepared } : {})
    })
    if (outcome.state !== 'rejected') {
      throw new Error(`expected a refusal, got ${outcome.state}`)
    }
    expect(outcome.rejection).toEqual({ kind: 'writeFailed', neverReachedAgent: true })
    const owedAfter = agentSessionStoppedHistoryOwed({
      submissions: [
        ...stopped.map((entry) => entry.submission),
        {
          ...stopped[0]!.submission,
          clientMessageId: 'next',
          payloadFingerprint: 'next',
          acceptedSequence: 3,
          dispatchState: 'rejected',
          reason: outcome.reason,
          rejection: outcome.rejection
        }
      ],
      carried: new Map([['next', prepared?.carries ?? []]]),
      clearSequence: 0,
      body: (id) => stopped.find((entry) => entry.submission.clientMessageId === id)?.body ?? null
    })
    expect(owedAfter.map((entry) => entry.submission.clientMessageId)).toEqual(['a', 'b'])
  })
})
