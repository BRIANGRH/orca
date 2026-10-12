// Stopped messages written into Codex's own log: one `thread/inject_items` holding each message and
// Codex's own user-role `<turn_aborted>` record, only while no turn runs, at most once.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import {
  CODEX_TURN_ABORTED_MARKER,
  injectCodexStoppedMessages
} from './codex-stopped-message-append'

function stopped(id: string, blocks: AgentJournalMessageItem['blocks']): OwedStoppedMessage {
  return {
    body: { kind: 'message', role: 'user', blocks },
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

function session(answer: () => Promise<unknown> = async () => ({})) {
  const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => answer())
  return {
    request,
    host: {
      ended: false,
      threadId: 'thread-1',
      activeTurnIds: new Set<string>(),
      dispatchPending: false,
      connection: { closed: false, request }
    }
  }
}

const marker = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: CODEX_TURN_ABORTED_MARKER }]
}

let folder: string | null = null
afterEach(async () => {
  if (folder) {
    await rm(folder, { recursive: true, force: true })
    folder = null
  }
})

describe('appending stopped messages to Codex', () => {
  it('injects every message and its interruption in one call, as measured on 0.159.0', async () => {
    const { request, host } = session()
    const outcome = await injectCodexStoppedMessages(host, [
      stopped('a', [{ type: 'text', text: 'Reply with only the word pinecone' }]),
      stopped('b', [{ type: 'text', text: 'then rebuild' }])
    ])

    expect(outcome).toEqual({ outcome: 'accepted' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toEqual([
      'thread/inject_items',
      {
        threadId: 'thread-1',
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with only the word pinecone' }]
          },
          marker,
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'then rebuild' }]
          },
          marker
        ]
      },
      { timeoutMs: 5_000 }
    ])
    expect(CODEX_TURN_ABORTED_MARKER).toBe(
      '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'
    )
  })

  it('carries images in the order sent, inline, and leaves out one it cannot send', async () => {
    folder = await mkdtemp(join(tmpdir(), 'codex-stopped-'))
    const png = join(folder, 'shot.png')
    await writeFile(png, Buffer.from([1, 2, 3]))
    const { request, host } = session()
    await injectCodexStoppedMessages(host, [
      stopped('a', [
        { type: 'image-ref', path: png },
        { type: 'text', text: 'look' },
        { type: 'image-ref', url: 'https://example.com/a.png' },
        { type: 'image-ref', path: join(folder, 'missing.png') },
        { type: 'image-ref', path: join(folder, 'drawing.svg') }
      ])
    ])

    expect(request.mock.calls[0]?.[1]?.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`
          },
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://example.com/a.png' }
        ]
      },
      marker
    ])
  })

  it('is refused, writing nothing, while a turn runs or a send is being handed over', async () => {
    for (const busy of [{ activeTurnIds: new Set(['turn-1']) }, { dispatchPending: true }]) {
      const { request, host } = session()
      expect(
        await injectCodexStoppedMessages({ ...host, ...busy }, [
          stopped('a', [{ type: 'text', text: 'a' }])
        ])
      ).toMatchObject({ outcome: 'refused' })
      expect(request).not.toHaveBeenCalled()
    }
  })

  it('is refused, writing nothing, when Codex is gone', async () => {
    const { request, host } = session()
    for (const gone of [
      undefined,
      { ...host, ended: true },
      { ...host, connection: { ...host.connection, closed: true } }
    ]) {
      expect(
        await injectCodexStoppedMessages(gone, [stopped('a', [{ type: 'text', text: 'a' }])])
      ).toMatchObject({ outcome: 'refused' })
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('is refused only on "no such method", so a Codex without inject keeps them owed', async () => {
    const { host } = session(async () => {
      throw new CodexAppServerRequestError('thread/inject_items', -32601, 'Method not found')
    })
    expect(
      await injectCodexStoppedMessages(host, [stopped('a', [{ type: 'text', text: 'a' }])])
    ).toEqual({ outcome: 'refused', reason: 'this Codex cannot append to its log' })
  })

  it('is unknown on any other error or lost contact: Codex may have recorded them', async () => {
    for (const error of [
      new CodexAppServerRequestError('thread/inject_items', -32603, 'persist failed'),
      new Error('codex app-server request timed out'),
      new Error('codex app-server connection closed')
    ]) {
      const { host } = session(async () => {
        throw error
      })
      expect(
        await injectCodexStoppedMessages(host, [stopped('a', [{ type: 'text', text: 'a' }])])
      ).toEqual({ outcome: 'unknown', reason: error.message })
    }
  })
})
