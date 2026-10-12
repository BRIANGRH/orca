// How each agent receives stopped messages in the same write as the person's next send: one frame
// for all, the send's own words last, images numbered in the order sent, and exactly the prepared
// payload written, so the row's `carries` names what the agent got.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../../shared/agent-session-stopped-history'
import type { NativeChatBlock } from '../../../shared/native-chat-types'
import {
  claudeDispatchInvokesSlashCommand,
  prepareClaudeDispatch
} from '../../claude/claude-structured-dispatch-content'
import { dispatchClaudeTurn } from '../../claude/claude-structured-dispatch'
import { sessionFor } from '../../claude/claude-structured-dispatch-test-support'
import {
  prepareCodexDispatch,
  startCodexTurn,
  type CodexTurnHost
} from '../../codex/codex-structured-turn-start'
import { createCodexDispatchEchoes } from '../../codex/codex-structured-dispatch-echo'
import { preparePiRpcDispatch } from '../../pi/rpc-prompt'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'stopped-history-rendering-'))
const png = join(dir, 'shot.png')
writeFileSync(png, PNG)

function message(...blocks: NativeChatBlock[]): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
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

const text = (value: string): NativeChatBlock => ({ type: 'text', text: value })
const image: NativeChatBlock = { type: 'image-ref', path: png }

/** A field of a value the adapter built, read without asserting its type. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

/** How many stopped messages a frame holds. */
function elements(frame: string): number {
  return frame.match(/<stopped-message number=/g)?.length ?? 0
}

const STOPPED = owed('a', message(text('delete the build folder')))
const STOPPED_WITH_IMAGE = owed('b', message(image, text('look at this')))
const NEXT = message(text('what did I send?'))

describe('Claude: one user frame', () => {
  it('leads with the history images, then one text that ends with the send, as the prompt', async () => {
    const prepared = (await prepareClaudeDispatch(NEXT, [STOPPED, STOPPED_WITH_IMAGE]))!

    expect(prepared.carries).toEqual(['a', 'b'])
    expect(prepared.content.map((part) => field(part, 'type'))).toEqual(['image', 'text'])
    const prompt = String(field(prepared.content.at(-1), 'text'))
    expect(prompt.startsWith('<stopped-history>\n')).toBe(true)
    expect(prompt.indexOf('delete the build folder')).toBeLessThan(prompt.indexOf('look at this'))
    expect(prompt).toContain('<stopped-message number="2" images="1">')
    expect(prompt.endsWith('</stopped-history>\n\nUser message:\nwhat did I send?')).toBe(true)
    expect(claudeDispatchInvokesSlashCommand(prepared.content)).toBe(false)
  })

  it('numbers the send’s own images after the history’s, on its label', async () => {
    const prepared = (await prepareClaudeDispatch(message(image, text('and this?')), [
      STOPPED_WITH_IMAGE
    ]))!
    expect(prepared.content.map((part) => field(part, 'type'))).toEqual(['image', 'image', 'text'])
    expect(String(field(prepared.content.at(-1), 'text'))).toContain(
      'User message (image 2):\nand this?'
    )
  })

  it('writes exactly the prepared frame, reading no image again', async () => {
    const own = join(mkdtempSync(join(tmpdir(), 'stopped-history-claude-')), 'own.png')
    writeFileSync(own, PNG)
    const stops = Array.from({ length: 5 }, (_, index) =>
      owed(`s${index}`, message(text(`stop ${index}`)))
    )
    const prepared = (await prepareClaudeDispatch(
      message({ type: 'image-ref', path: own }),
      stops
    ))!
    // Read once, during preparation: the write needs nothing from disk.
    rmSync(own)
    const send = vi.fn().mockResolvedValue(undefined)
    const session = sessionFor(send)
    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'next', body: NEXT, prepared })
    ).resolves.toEqual({ state: 'admitted' })

    const written: unknown = send.mock.calls[0]![0]
    expect(field(field(written, 'message'), 'content')).toBe(prepared.content)
    expect(elements(String(field(prepared.content.at(-1), 'text')))).toBe(prepared.carries.length)
    expect(prepared.carries).toEqual(['s0', 's1', 's2', 's3', 's4'])
  })

  it('leaves a stopped message’s images out, noted, past Claude’s image limit', async () => {
    const many = owed('many', message(...Array.from({ length: 21 }, () => image), text('all')))
    const prepared = (await prepareClaudeDispatch(NEXT, [many]))!
    expect(prepared.carries).toEqual(['many'])
    expect(prepared.content).toHaveLength(1)
    expect(String(field(prepared.content[0], 'text'))).toContain('omitted-images="21"')
  })

  it('prepares nothing for a send Claude would refuse on its own', async () => {
    expect(await prepareClaudeDispatch(message(), [STOPPED])).toBeNull()
  })
})

describe('Codex: the same turn/start or turn/steer', () => {
  type Request = CodexTurnHost['connection']['request']

  function host(request: Request): CodexTurnHost {
    return {
      connection: { request },
      threadId: 'thread-1',
      options: new Map(),
      dispatchEchoes: createCodexDispatchEchoes(),
      turnOpenWaits: { wait: async () => undefined }
    }
  }

  it('writes exactly the prepared input, history images then the frame then the send', async () => {
    const prepared = (await prepareCodexDispatch(NEXT, [STOPPED, STOPPED_WITH_IMAGE]))!
    expect(prepared.carries).toEqual(['a', 'b'])
    expect(prepared.input.map((item) => item.type)).toEqual(['localImage', 'text', 'text'])
    expect(String(prepared.input[1]!.text).endsWith('\n\nUser message:')).toBe(true)
    expect(elements(String(prepared.input[1]!.text))).toBe(2)
    expect(prepared.input[2]).toEqual({ type: 'text', text: 'what did I send?' })

    const start = vi.fn<Request>(async () => ({ turn: { id: 'turn-1' } }))
    await startCodexTurn(host(start), { clientMessageId: 'next-1', body: NEXT, prepared })
    const steer = vi.fn<Request>(async () => ({ turnId: 'turn-1' }))
    await startCodexTurn(
      { ...host(steer), activeTurnIds: new Set(['turn-1']) },
      { clientMessageId: 'next-2', body: NEXT, prepared }
    )
    for (const [request, method] of [
      [start, 'turn/start'],
      [steer, 'turn/steer']
    ] as const) {
      const [sent, params] = request.mock.calls[0]!
      expect(sent).toBe(method)
      expect(params?.input).toBe(prepared.input)
    }
  })

  it("shortens what passes Codex's text limit, counted across the whole input", async () => {
    const half = (id: string) => owed(id, message(text('x'.repeat(600_000))))
    const prepared = (await prepareCodexDispatch(NEXT, [half('one'), half('two')]))!
    const chars = prepared.input.reduce(
      (sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0),
      0
    )
    expect(prepared.carries).toEqual(['one', 'two'])
    expect(chars).toBeLessThanOrEqual(1 << 20)
    expect(String(prepared.input[0]!.text)).toContain(
      '<stopped-message number="2" images="none" shortened="true">'
    )
  })
})

describe('Pi: one text and the images in numbered order', () => {
  it('joins the frame and the send into one text, history images first', async () => {
    const own = message(image, text('and this?'))
    const prepared = (await preparePiRpcDispatch(own, [STOPPED, STOPPED_WITH_IMAGE], 1 << 30))!
    expect(prepared.carries).toEqual(['a', 'b'])
    expect(prepared.prompt.message.endsWith('User message (image 2):\nand this?')).toBe(true)
    expect(elements(prepared.prompt.message)).toBe(2)
    expect(prepared.prompt.images).toEqual([
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }
    ])
  })

  it('fits what its prompt queue can still hold, shortening the rest', async () => {
    const long = owed('long', message(text('y'.repeat(50_000))))
    const prepared = (await preparePiRpcDispatch(NEXT, [STOPPED, long], 4_000))!
    expect(prepared.carries).toEqual(['a', 'long'])
    expect(Buffer.byteLength(JSON.stringify(prepared.prompt))).toBeLessThanOrEqual(4_000)
    expect(prepared.prompt.message).toContain('shortened="true"')
  })

  it('carries nothing when the queue is all but full', async () => {
    expect(await preparePiRpcDispatch(NEXT, [STOPPED], 300)).toBeNull()
  })
})
