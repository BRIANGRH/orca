// An ACP send carrying stopped messages writes exactly the prompt it was prepared with, within the
// one JSON-RPC line the writer allows, and a line the writer refuses never counts as delivered.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { NdjsonLineTooLongError } from '../../shared/main-process-ndjson-framer'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { resolveAcpPeerOptions } from './acp-peer-limits'
import { openAcpAdapterRig, sendHello, waitFor } from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function owed(id: string, body: AgentJournalMessageItem): OwedStoppedMessage {
  return {
    body,
    submission: {
      clientMessageId: id,
      fence: 1,
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

const NEXT = message('what did I send?')

/** The content blocks a written `session/prompt` frame carries. */
function promptOf(frame: { params?: unknown }): unknown[] {
  const params = frame.params
  const prompt =
    typeof params === 'object' && params !== null && 'prompt' in params ? params.prompt : null
  return Array.isArray(prompt) ? prompt : []
}

async function prepareAndSend(owedMessages: OwedStoppedMessage[], body = NEXT) {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  const prepared = await rig.adapter.prepareDispatch({
    sessionId: SESSION,
    fence: 1,
    body,
    owed: owedMessages
  })
  const outcome = await rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'next',
    body,
    fence: 1,
    ...(prepared ? { prepared } : {})
  })
  return { rig, prepared, outcome }
}

describe('ACP stopped history', () => {
  it("writes exactly the prepared blocks: each stopped message and its interruption lead the send's words", async () => {
    const image: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'image-ref', path: '/workspace/shot.png' },
        { type: 'text', text: 'look' }
      ]
    }
    const { rig, prepared, outcome } = await prepareAndSend([
      owed('a', message('delete the build folder')),
      owed('b', image)
    ])
    expect(outcome).toEqual({ state: 'admitted' })
    expect(prepared?.carries).toEqual(['a', 'b'])
    // This agent takes no images, so the stopped one's is left out and the message rides whole.
    expect(promptOf(await rig.frame('session/prompt'))).toEqual([
      {
        type: 'text',
        text:
          'delete the build folder\n\n[Request interrupted by user]\n\n' +
          'look\n\n[Request interrupted by user]\n\n' +
          'what did I send?'
      }
    ])
  })

  it('carries only whole messages within the real line limit; the first that does not fit waits with the rest', async () => {
    const maxLineBytes = resolveAcpPeerOptions().maxLineBytes
    // Room beside the send for one of the stopped messages, not two.
    const long = message('w'.repeat(maxLineBytes - 64 * 1024 - 70_000))
    const { rig, prepared, outcome } = await prepareAndSend(
      [
        owed('one', message('x'.repeat(40_000))),
        owed('two', message('y'.repeat(40_000))),
        owed('three', message('z'))
      ],
      long
    )

    expect(outcome).toEqual({ state: 'admitted' })
    const written = await rig.frame('session/prompt')
    expect(Buffer.byteLength(JSON.stringify(written))).toBeLessThanOrEqual(maxLineBytes)
    expect(prepared?.carries).toEqual(['one'])
    expect(promptOf(written)).toEqual([
      {
        type: 'text',
        text: `${'x'.repeat(40_000)}\n\n[Request interrupted by user]\n\n${'w'.repeat(maxLineBytes - 64 * 1024 - 70_000)}`
      }
    ])
  })

  it('refuses a text-only send too large for one line before writing it', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const outcome = await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'huge',
      body: message('x'.repeat(resolveAcpPeerOptions().maxLineBytes)),
      fence: 1
    })
    expect(outcome).toMatchObject({ state: 'rejected', rejection: { kind: 'writeFailed' } })
    expect(rig.sent('session/prompt')).toEqual([])
  })

  it('settles a line the writer refused as never reaching the agent, not as accepted', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    vi.spyOn(rig.child(), 'prompt').mockRejectedValueOnce(new NdjsonLineTooLongError(20, 10))
    expect(await sendHello(rig, 'refused')).toEqual({ state: 'admitted' })

    await waitFor(() =>
      expect(rig.settled).toEqual([
        expect.objectContaining({
          clientMessageId: 'refused',
          state: 'rejected',
          rejection: { kind: 'writeFailed', neverReachedAgent: true }
        })
      ])
    )
    // The session is free for the next send.
    await sendHello(rig, 'after')
    await rig.frame('session/prompt')
  })
})
