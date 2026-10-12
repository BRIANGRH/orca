// Stopped messages written into Codex's own log: one `thread/inject_items` holding each message and
// Codex's own user-role `<turn_aborted>` record, only while no turn runs, at most once.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeDispatchContent from '../claude/claude-structured-dispatch-content'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { readClaudeImage } from '../claude/claude-structured-dispatch-content'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import {
  CODEX_TURN_ABORTED_MARKER,
  injectCodexStoppedMessages
} from './codex-stopped-message-append'

vi.mock('../claude/claude-structured-dispatch-content', async (original) => {
  const actual = await original<typeof ClaudeDispatchContent>()
  return { ...actual, readClaudeImage: vi.fn(actual.readClaudeImage) }
})

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
      fence: 1,
      threadId: 'thread-1',
      activeTurnIds: new Set<string>(),
      dispatchPending: false,
      connection: { closed: false, request }
    }
  }
}

type Host = ReturnType<typeof session>['host']

function inject(
  host: Host | undefined | (() => Host | undefined),
  messages: readonly OwedStoppedMessage[],
  turnLive = () => false,
  timeoutMs?: { prepare: number; settle: number }
) {
  return injectCodexStoppedMessages(
    typeof host === 'function' ? host : () => host,
    { fence: 1, messages, turnLive },
    timeoutMs
  )
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
    const outcome = await inject(host, [
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
      { timeoutMs: 2_000 }
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
    await inject(host, [
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
          { type: 'input_text', text: 'look' }
        ]
      },
      marker
    ])
  })

  it('leaves out a remote image, which Codex refuses before recording anything, and keeps the words', async () => {
    const { request, host } = session()
    expect(
      await inject(host, [
        stopped('a', [
          { type: 'image-ref', url: 'https://example.com/a.png' },
          { type: 'text', text: 'what is this' }
        ])
      ])
    ).toEqual({ outcome: 'accepted' })
    expect(request.mock.calls[0]?.[1]?.items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this' }] },
      marker
    ])
  })

  it('is refused, writing nothing, while a turn runs or a send is being handed over', async () => {
    for (const busy of [{ activeTurnIds: new Set(['turn-1']) }, { dispatchPending: true }]) {
      const { request, host } = session()
      expect(
        await inject({ ...host, ...busy }, [stopped('a', [{ type: 'text', text: 'a' }])])
      ).toMatchObject({ outcome: 'refused' })
      expect(request).not.toHaveBeenCalled()
    }
    const { request, host } = session()
    expect(
      await inject(host, [stopped('a', [{ type: 'text', text: 'a' }])], () => true)
    ).toMatchObject({ outcome: 'refused', reason: 'Codex is running a turn' })
    expect(request).not.toHaveBeenCalled()
  })

  it('checks again right before the write: a turn that started while it prepared refuses it', async () => {
    for (const started of [
      (host: Host) => host.activeTurnIds.add('turn-1'),
      (host: Host) => {
        host.dispatchPending = true
      }
    ]) {
      const { request, host } = session()
      const read = vi.mocked(readClaudeImage).mockImplementationOnce(async () => {
        started(host)
        return Buffer.from([1])
      })
      expect(
        await inject(host, [stopped('a', [{ type: 'image-ref', path: '/tmp/shot.png' }])])
      ).toEqual({ outcome: 'refused', reason: 'Codex is running a turn' })
      expect(read).toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
    // Orca's own journal opened a turn meanwhile.
    const { request, host } = session()
    let live = false
    vi.mocked(readClaudeImage).mockImplementationOnce(async () => {
      live = true
      return Buffer.from([1])
    })
    expect(
      await inject(host, [stopped('a', [{ type: 'image-ref', path: '/tmp/shot.png' }])], () => live)
    ).toEqual({ outcome: 'refused', reason: 'Codex is running a turn' })
    expect(request).not.toHaveBeenCalled()
  })

  it('is refused, not unknown, when the child died while it prepared: nothing was written', async () => {
    for (const died of [
      (host: Host) => {
        host.ended = true
      },
      (host: Host) => {
        host.connection.closed = true
      },
      (host: Host) => {
        host.fence = 2
      }
    ]) {
      const { request, host } = session()
      vi.mocked(readClaudeImage).mockImplementationOnce(async () => {
        died(host)
        return Buffer.from([1])
      })
      expect(
        await inject(host, [stopped('a', [{ type: 'image-ref', path: '/tmp/shot.png' }])])
      ).toEqual({ outcome: 'refused', reason: 'Codex ended before the append' })
      expect(request).not.toHaveBeenCalled()
    }
    // A new child took the session meanwhile.
    const { request, host } = session()
    let current: Host | undefined = host
    vi.mocked(readClaudeImage).mockImplementationOnce(async () => {
      current = session().host
      return Buffer.from([1])
    })
    expect(
      await inject(() => current, [stopped('a', [{ type: 'image-ref', path: '/tmp/shot.png' }])])
    ).toEqual({ outcome: 'refused', reason: 'Codex ended before the append' })
    expect(request).not.toHaveBeenCalled()
  })

  it('gives up on a stalled image read in time, refused, and never injects it later', async () => {
    const { request, host } = session()
    let readLate: (bytes: Buffer) => void = () => {}
    vi.mocked(readClaudeImage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          readLate = resolve
        })
    )
    const started = Date.now()
    expect(
      await inject(
        host,
        [stopped('a', [{ type: 'image-ref', path: '/tmp/shot.png' }])],
        () => false,
        { prepare: 50, settle: 50 }
      )
    ).toEqual({ outcome: 'refused', reason: 'reading the stopped messages took too long' })
    expect(Date.now() - started).toBeLessThan(1_000)
    readLate(Buffer.from([1]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(request).not.toHaveBeenCalled()
  })

  it('has nothing to write when nothing in the messages reads any more', async () => {
    const { request, host } = session()
    expect(
      await inject(host, [stopped('a', [{ type: 'image-ref', url: 'https://example.com/a.png' }])])
    ).toEqual({ outcome: 'unreadable' })
    expect(request).not.toHaveBeenCalled()
  })

  it('is refused, writing nothing, when Codex is gone', async () => {
    const { request, host } = session()
    for (const gone of [
      undefined,
      { ...host, ended: true },
      { ...host, connection: { ...host.connection, closed: true } }
    ]) {
      expect(await inject(gone, [stopped('a', [{ type: 'text', text: 'a' }])])).toMatchObject({
        outcome: 'refused'
      })
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('is unknown on any error or lost contact: Codex may have recorded them', async () => {
    for (const error of [
      new CodexAppServerRequestError('thread/inject_items', -32603, 'persist failed'),
      // What Orca's connection makes of a Codex too old for the method: never asked again.
      new CodexAppServerUnsupportedError('thread/inject_items is unsupported'),
      new Error('codex app-server request timed out'),
      new Error('codex app-server connection closed')
    ]) {
      const { host } = session(async () => {
        throw error
      })
      expect(await inject(host, [stopped('a', [{ type: 'text', text: 'a' }])])).toEqual({
        outcome: 'unknown',
        reason: error.message
      })
    }
  })
})
