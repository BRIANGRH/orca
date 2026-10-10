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
import { startCodexTurn, type CodexTurnHost } from '../../codex/codex-structured-turn-start'
import { createCodexDispatchEchoes } from '../../codex/codex-structured-dispatch-echo'
import { CodexAppServerRequestError } from '../../codex/codex-app-server-request-error'
import {
  STOPPED_MESSAGE_FRAME,
  stoppedMessageContext
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
    expect(stoppedMessageContext(STOPPED_WITH_IMAGE)).toContain('It had 1 image(s)')
  })
})

describe('Claude: one user frame', () => {
  it('leads with the framed history and keeps the send last, as the prompt', async () => {
    const content = await claudeDispatchContentWithHistory(NEXT, [STOPPED, STOPPED_WITH_IMAGE])

    expect(content.map((part) => field(part, 'type'))).toEqual(['image', 'text'])
    const prompt = String(field(content.at(-1), 'text'))
    expect(prompt.indexOf('delete the build folder')).toBeLessThan(prompt.indexOf('look at this'))
    expect(prompt.endsWith('\nwhat did I send?')).toBe(true)
    expect(prompt.split(STOPPED_MESSAGE_FRAME)).toHaveLength(3)
    expect(claudeDispatchInvokesSlashCommand(content)).toBe(false)
  })

  it('does not fit past its image limit, and then sends the send alone', async () => {
    const many = message(...Array.from({ length: 21 }, () => image))
    expect(await claudeStoppedHistoryFits(NEXT, [many])).toBe(false)
    expect(await claudeDispatchContentWithHistory(NEXT, [many])).toEqual([
      { type: 'text', text: 'what did I send?' }
    ])
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

  it('sends text-only stopped messages as untrusted context, keyed in send order, and image ones as leading input', async () => {
    const request = vi.fn<Request>(async () => ({ turn: { id: 'turn-1' } }))
    const second = message(text('second'))
    await startCodexTurn(host(request), {
      clientMessageId: 'next-1',
      body: NEXT,
      history: [STOPPED, STOPPED_WITH_IMAGE, second]
    })

    const [method, params] = request.mock.calls[0]!
    expect(method).toBe('turn/start')
    const context = params?.additionalContext
    expect(context).toEqual({
      'orca_stopped_next-1_000': { kind: 'untrusted', value: stoppedMessageContext(STOPPED) },
      'orca_stopped_next-1_002': { kind: 'untrusted', value: stoppedMessageContext(second) }
    })
    // Codex reads the keys in sorted order: that order is send order.
    const keys = Object.keys(context ?? {})
    expect([...keys].sort()).toEqual(keys)
    expect(params?.input).toEqual([
      { type: 'localImage', path: png },
      { type: 'text', text: stoppedMessageContext(STOPPED_WITH_IMAGE) },
      { type: 'text', text: 'what did I send?' }
    ])
  })

  it('a Codex that refuses the field takes them as leading input in a second request', async () => {
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new CodexAppServerRequestError('turn/start', -32602, 'unknown field'))
      .mockResolvedValueOnce({ turn: { id: 'turn-1' } })
    await startCodexTurn(host(request), {
      clientMessageId: 'next-1',
      body: NEXT,
      history: [STOPPED]
    })

    expect(request).toHaveBeenCalledTimes(2)
    const params = request.mock.calls[1]![1]
    expect(params?.additionalContext).toBeUndefined()
    expect(params?.input).toEqual([
      { type: 'text', text: stoppedMessageContext(STOPPED) },
      { type: 'text', text: 'what did I send?' }
    ])
  })

  it('a send that steers a running turn takes them as leading input', async () => {
    const request = vi.fn<Request>(async () => ({ turnId: 'turn-1' }))
    await startCodexTurn(
      { ...host(request), activeTurnIds: new Set(['turn-1']) },
      { clientMessageId: 'next-1', body: NEXT, history: [STOPPED] }
    )

    const [method, params] = request.mock.calls[0]!
    expect(method).toBe('turn/steer')
    expect(params?.input).toEqual([
      { type: 'text', text: stoppedMessageContext(STOPPED) },
      { type: 'text', text: 'what did I send?' }
    ])
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
    const blocks = await acpDispatchPromptWithHistory(NEXT, [STOPPED_WITH_IMAGE], session)

    expect(blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
      { type: 'text', text: stoppedMessageContext(STOPPED_WITH_IMAGE) },
      { type: 'text', text: 'what did I send?' }
    ])
  })

  it('does not fit an image the agent cannot take, and sends the send alone', async () => {
    expect(await acpStoppedHistoryFits(NEXT, [STOPPED_WITH_IMAGE], textOnly)).toBe(false)
    expect(await acpDispatchPromptWithHistory(NEXT, [STOPPED_WITH_IMAGE], textOnly)).toEqual([
      { type: 'text', text: 'what did I send?' }
    ])
  })
})

describe('Pi: a framed text prefix and the images', () => {
  it('prefixes the framed history and sends its images', async () => {
    const prompt = await preparePiRpcPromptWithHistory(NEXT, [STOPPED, STOPPED_WITH_IMAGE])

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
    expect((await preparePiRpcPromptWithHistory(NEXT, [many])).message).toBe('what did I send?')
  })
})
