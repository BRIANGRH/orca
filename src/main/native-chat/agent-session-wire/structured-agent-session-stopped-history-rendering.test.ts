// How each agent receives stopped messages in the same write as the person's next send: one
// framing line for all, the send's own words last, images kept, and the send alone when the
// history does not fit.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat-types'
import {
  claudeDispatchContentWithHistory,
  claudeDispatchInvokesSlashCommand,
  claudeStoppedHistoryFits
} from '../../claude/claude-structured-dispatch-content'
import { acpDispatchPromptWithHistory, acpStoppedHistoryFits } from '../../acp/acp-prompt-content'
import { piStoppedHistoryFits, preparePiRpcPromptWithHistory } from '../../pi/rpc-prompt'
import {
  codexStoppedHistoryFits,
  startCodexTurn,
  type CodexTurnHost
} from '../../codex/codex-structured-turn-start'
import { createCodexDispatchEchoes } from '../../codex/codex-structured-dispatch-echo'
import {
  STOPPED_MESSAGE_FRAME,
  stoppedMessageContext,
  stoppedMessageWithoutImages
} from './structured-agent-session-stopped-history-frame'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const dir = mkdtempSync(join(tmpdir(), 'stopped-history-rendering-'))
const png = join(dir, 'shot.png')
writeFileSync(png, PNG)

function message(...blocks: NativeChatBlock[]): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

const text = (value: string): NativeChatBlock => ({ type: 'text', text: value })
const image: NativeChatBlock = { type: 'image-ref', path: png }

/** A field of a value the adapter built, read without asserting its type. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

const STOPPED = message(text('delete the build folder'))
const STOPPED_WITH_IMAGE = message(image, text('look at this'))
const NEXT = message(text('what did I send?'))

describe('the shared frame', () => {
  it('names a stopped message as context, not a request, with its own words inside', () => {
    expect(stoppedMessageContext(STOPPED)).toBe(
      `<stopped-message>\n${STOPPED_MESSAGE_FRAME}\ndelete the build folder\n</stopped-message>`
    )
    expect(stoppedMessageContext(STOPPED_WITH_IMAGE)).toContain('It had 1 image(s), attached ahead')
  })

  it('says when a stopped message rides without its images', () => {
    const textOnly = stoppedMessageWithoutImages(STOPPED_WITH_IMAGE)
    expect(textOnly.blocks.some((block) => block.type === 'image-ref')).toBe(false)
    expect(stoppedMessageContext(textOnly)).toBe(
      `<stopped-message>\n${STOPPED_MESSAGE_FRAME}\nIt had 1 image(s), not attached.\nlook at this\n</stopped-message>`
    )
    expect(stoppedMessageWithoutImages(STOPPED)).toBe(STOPPED)
  })
})

describe('Claude: one user frame', () => {
  it('leads with the framed history and keeps the send last, as the prompt', async () => {
    const content = await claudeDispatchContentWithHistory(
      NEXT,
      [STOPPED, STOPPED_WITH_IMAGE],
      () => {}
    )

    expect(content.map((part) => field(part, 'type'))).toEqual(['image', 'text'])
    const prompt = String(field(content.at(-1), 'text'))
    expect(prompt.indexOf('delete the build folder')).toBeLessThan(prompt.indexOf('look at this'))
    expect(prompt.endsWith('\nwhat did I send?')).toBe(true)
    expect(prompt.split(STOPPED_MESSAGE_FRAME)).toHaveLength(3)
    expect(claudeDispatchInvokesSlashCommand(content)).toBe(false)
  })

  it('does not fit past its image limit, and then sends the send alone, reported', async () => {
    const many = message(...Array.from({ length: 21 }, () => image))
    const report = vi.fn()
    expect(await claudeStoppedHistoryFits(NEXT, [many])).toBe(false)
    expect(await claudeDispatchContentWithHistory(NEXT, [many], report)).toEqual([
      { type: 'text', text: 'what did I send?' }
    ])
    expect(report).toHaveBeenCalledTimes(1)
  })
})

describe('Codex: the same turn/start', () => {
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

  it('leads the input with every stopped message, images first, on a start and on a steer', async () => {
    const second = message(text('second'))
    const history = [STOPPED, STOPPED_WITH_IMAGE, second]
    const expected = [
      { type: 'localImage', path: png },
      {
        type: 'text',
        text: [STOPPED, STOPPED_WITH_IMAGE, second].map(stoppedMessageContext).join('\n\n')
      },
      { type: 'text', text: 'what did I send?' }
    ]
    const start = vi.fn<Request>(async () => ({ turn: { id: 'turn-1' } }))
    await startCodexTurn(host(start), { clientMessageId: 'next-1', body: NEXT, history })
    const steer = vi.fn<Request>(async () => ({ turnId: 'turn-1' }))
    await startCodexTurn(
      { ...host(steer), activeTurnIds: new Set(['turn-1']) },
      { clientMessageId: 'next-2', body: NEXT, history }
    )

    for (const [request, method] of [
      [start, 'turn/start'],
      [steer, 'turn/steer']
    ] as const) {
      expect(request).toHaveBeenCalledTimes(1)
      const [sent, params] = request.mock.calls[0]!
      expect(sent).toBe(method)
      expect(params?.additionalContext).toBeUndefined()
      expect(params?.input).toEqual(expected)
    }
  })

  it("fits only within Codex's text limit, counted across the whole input", () => {
    const half = message(text('x'.repeat(600_000)))
    expect(codexStoppedHistoryFits(NEXT, [half])).toBe(true)
    expect(codexStoppedHistoryFits(NEXT, [half, half])).toBe(false)
    // Images do not count toward it.
    expect(codexStoppedHistoryFits(NEXT, [STOPPED_WITH_IMAGE])).toBe(true)
  })
})

describe('ACP: leading framed blocks', () => {
  const connection = {
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } }
    })
  }
  const session = { spec: { agent: 'opencode' as const, imagePrompts: true as const }, connection }
  const textOnly = { spec: { agent: 'opencode' as const }, connection }

  it('leads the prompt with the history images and framed text, then the send', async () => {
    const blocks = await acpDispatchPromptWithHistory(
      { body: NEXT, history: [STOPPED_WITH_IMAGE] },
      session,
      () => {}
    )

    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
      { type: 'text', text: stoppedMessageContext(STOPPED_WITH_IMAGE) },
      { type: 'text', text: 'what did I send?' }
    ])
  })

  it('does not fit an image the agent cannot take, and sends the send alone, reported', async () => {
    const report = vi.fn()
    expect(await acpStoppedHistoryFits(NEXT, [STOPPED_WITH_IMAGE], textOnly)).toBe(false)
    expect(
      await acpDispatchPromptWithHistory(
        { body: NEXT, history: [STOPPED_WITH_IMAGE] },
        textOnly,
        report
      )
    ).toEqual([{ type: 'text', text: 'what did I send?' }])
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('fits once the image is left out', async () => {
    expect(
      await acpStoppedHistoryFits(NEXT, [stoppedMessageWithoutImages(STOPPED_WITH_IMAGE)], textOnly)
    ).toBe(true)
  })
})

describe('Pi: a framed text prefix and the images', () => {
  it('prefixes the framed history and sends its images', async () => {
    const prompt = await preparePiRpcPromptWithHistory(
      NEXT,
      [STOPPED, STOPPED_WITH_IMAGE],
      () => {}
    )

    expect(prompt.message).toBe(
      `${stoppedMessageContext(STOPPED)}\n\n${stoppedMessageContext(STOPPED_WITH_IMAGE)}\nwhat did I send?`
    )
    expect(prompt.images).toEqual([
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }
    ])
  })

  it('does not fit past its image limit, and sends the send alone', async () => {
    const many = message(...Array.from({ length: 21 }, () => image))
    expect(await piStoppedHistoryFits(NEXT, [many])).toBe(false)
    const report = vi.fn()
    expect((await preparePiRpcPromptWithHistory(NEXT, [many], report)).message).toBe(
      'what did I send?'
    )
    expect(report).toHaveBeenCalledTimes(1)
  })
})
