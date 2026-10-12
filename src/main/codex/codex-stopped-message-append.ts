// Stopped messages written into Codex's own log without running a turn: one `thread/inject_items`
// holding, per message, the user message and then the user-role `<turn_aborted>` fragment Codex
// writes for its own Stop in its default mode (codex-rs/core/src/context/turn_aborted.rs). Codex
// answers `{}` and notifies nothing (measured, 0.159.0). Into a running turn it acts as a steer, so
// it goes in only while none runs.

import { extname } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionStoppedMessageAppendOutcome } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-adapter'
import { readClaudeImage } from '../claude/claude-structured-dispatch-content'
import { isCodexAppServerRequestError } from './codex-app-server-request-error'
import type { CodexSession } from './codex-structured-session-state'

export const CODEX_TURN_ABORTED_MARKER =
  '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'

const JSON_RPC_METHOD_NOT_FOUND = -32601
const CODEX_STOPPED_MESSAGE_APPEND_TIMEOUT_MS = 5_000
// What the Responses API takes as an inline image.
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

async function inlineImage(
  block: Extract<NativeChatBlock, { type: 'image-ref' }>
): Promise<Record<string, unknown> | null> {
  if (block.url) {
    return { type: 'input_image', image_url: block.url }
  }
  const mimeType = block.path ? IMAGE_FILE_MIME_TYPES[extname(block.path).toLowerCase()] : undefined
  if (!block.path || !mimeType || !INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return null
  }
  const bytes = await readClaudeImage(block.path)
  return {
    type: 'input_image',
    image_url: `data:${mimeType};base64,${bytes.toString('base64')}`
  }
}

/** The message's words and images as Codex response content, in the order sent, less any image
 *  that no longer reads. */
async function messageContent(body: AgentJournalMessageItem): Promise<Record<string, unknown>[]> {
  const content: Record<string, unknown>[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image-ref') {
      const image = await inlineImage(block).catch(() => null)
      if (image) {
        content.push(image)
      }
    }
  }
  return content
}

function userMessage(content: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'message', role: 'user', content }
}

/** The items one inject writes: each stopped message, then Codex's own record of its Stop. */
export async function codexStoppedMessageItems(
  messages: readonly OwedStoppedMessage[]
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  for (const { body } of messages) {
    const content = await messageContent(body)
    if (content.length > 0) {
      items.push(
        userMessage(content),
        userMessage([{ type: 'input_text', text: CODEX_TURN_ABORTED_MARKER }])
      )
    }
  }
  return items
}

/** The session state an inject reads. */
type CodexInjectHost = Pick<
  CodexSession,
  'ended' | 'threadId' | 'activeTurnIds' | 'dispatchPending'
> & {
  connection: Pick<CodexSession['connection'], 'closed' | 'request'>
}

export async function injectCodexStoppedMessages(
  session: CodexInjectHost | undefined,
  messages: readonly OwedStoppedMessage[],
  timeoutMs = CODEX_STOPPED_MESSAGE_APPEND_TIMEOUT_MS
): Promise<AgentSessionStoppedMessageAppendOutcome> {
  if (!session || session.ended || session.connection.closed) {
    return { outcome: 'refused', reason: 'Codex ended before the append' }
  }
  if (session.activeTurnIds?.size || session.dispatchPending) {
    return { outcome: 'refused', reason: 'Codex is running a turn' }
  }
  const items = await codexStoppedMessageItems(messages)
  if (items.length === 0) {
    return { outcome: 'unknown', reason: 'nothing readable to append' }
  }
  try {
    await session.connection.request(
      'thread/inject_items',
      { threadId: session.threadId, items },
      { timeoutMs }
    )
    return { outcome: 'accepted' }
  } catch (error) {
    // Only "no such method" proves nothing was recorded: Codex may record items and then fail.
    if (isCodexAppServerRequestError(error) && error.code === JSON_RPC_METHOD_NOT_FOUND) {
      return { outcome: 'refused', reason: 'this Codex cannot append to its log' }
    }
    return {
      outcome: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}
