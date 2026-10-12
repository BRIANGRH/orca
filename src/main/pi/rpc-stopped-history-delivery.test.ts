// A Pi send carrying stopped messages writes exactly the prompt it was prepared with: each one's
// words and the interruption Claude records for its own Stop, ahead of the send's own words.

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
import type * as ClaudeDispatchContent from '../claude/claude-structured-dispatch-content'
import { readClaudeImage } from '../claude/claude-structured-dispatch-content'
import { prepareStoppedHistory } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-selection'

vi.mock('../claude/claude-structured-dispatch-content', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeDispatchContent>()
  return { ...actual, readClaudeImage: vi.fn(actual.readClaudeImage) }
})

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
  it('writes exactly the prepared prompt: each stopped message and its interruption, then the send', async () => {
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
    expect(written?.message).toBe(
      'delete the build folder\n\n[Request interrupted by user]\n\n' +
        'then rebuild\n\n[Request interrupted by user]\n\n' +
        'what did I send?'
    )
  })

  it('carries only whole messages that fit the line Pi is written; the rest wait', async () => {
    const h = await setup()
    const maxLineBytes = resolveJsonlRpcPeerOptions().maxLineBytes
    const lines: string[] = []
    vi.spyOn(h.connection, 'send').mockImplementation(async (frame) => {
      lines.push(encodeNdjson(frame, maxLineBytes))
    })
    const body = message('x'.repeat(maxLineBytes - 60_000))
    const prepared = await h.adapter.prepareDispatch({
      sessionId,
      fence: 7,
      body,
      // The first fits whole; the second does not, so it and every later one wait.
      owed: [
        owed('a', 'a'.repeat(40_000)),
        owed('b', 'b'.repeat(40_000), 2),
        owed('c', 'then rebuild', 3)
      ]
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
    expect(
      written.message.startsWith(`${'a'.repeat(40_000)}\n\n[Request interrupted by user]\n\nx`)
    ).toBe(true)
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
      appended: new Map(),
      clearSequence: 0,
      body: (id) => stopped.find((entry) => entry.submission.clientMessageId === id)?.body ?? null
    })
    expect(owedAfter.map((entry) => entry.submission.clientMessageId)).toEqual(['a', 'b'])
  })

  it('a carried image that never reads leaves the send to go alone within the limit, history owed', async () => {
    const h = await setup()
    // A stalled drive: the read never settles, and Pi's own read has no deadline.
    vi.mocked(readClaudeImage).mockImplementationOnce(() => new Promise(() => {}))
    const stalled = owed('a', 'look')
    stalled.body.blocks.unshift({ type: 'image-ref', path: '/stalled/drive/shot.png' })
    const body = message('what did I send?')
    const logger = { warn: vi.fn(), error: vi.fn() }
    const startedAt = Date.now()
    const prepared = await prepareStoppedHistory(
      { sessionId, fence: 7, adapter: h.adapter, logger },
      body,
      [stalled],
      50
    )
    expect(prepared).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(
      await h.adapter.dispatch({ sessionId, fence: 7, clientMessageId: 'next', body })
    ).toEqual({ state: 'admitted' })

    expect(h.connection.sent).toEqual([
      expect.objectContaining({ type: 'prompt', message: 'what did I send?', images: [] })
    ])
  })
})
