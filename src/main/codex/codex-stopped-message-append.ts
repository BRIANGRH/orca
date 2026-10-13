// Stopped messages written into Codex's own log without running a turn: one `thread/inject_items`
// holding, per message, the user message and then the user-role `<turn_aborted>` fragment Codex
// writes for its own Stop in its default mode (codex-rs/core/src/context/turn_aborted.rs). Codex
// answers `{}` and notifies nothing (measured, 0.159.0). Into a running turn it acts as a steer, so
// it goes in only while none runs, checked again right before the write.

import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { hasReachedAppVersion } from '../../shared/app-version'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type {
  AgentSessionStoppedMessageAppendOutcome,
  AgentSessionStoppedMessageDelivery
} from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-adapter'
import { readStoppedImage } from '../native-chat/agent-session-wire/structured-agent-session-stopped-image-read'
import { readClaudeImage } from '../claude/claude-structured-dispatch-content'
import type { CodexSession } from './codex-structured-session-state'

export const CODEX_TURN_ABORTED_MARKER =
  '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'

// Each bound alone keeps a send queued behind the append waiting at most a few seconds.
const CODEX_STOPPED_MESSAGE_PREPARE_TIMEOUT_MS = 2_000
const CODEX_STOPPED_MESSAGE_APPEND_TIMEOUT_MS = 2_000
// What the Responses API takes as an inline image.
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// A send hands Codex any attachment Orca admits, by path, and so does an inject, inlined; Codex
// prepares either before recording it.
export const CODEX_STOPPED_MESSAGE_IMAGE_MAX_BYTES = AGENT_SESSION_ATTACHMENT_MAX_BYTES
// The first Codex whose inject resizes an inline image as it records it; an older one keeps it raw,
// and an image too large for the model would then fail every later turn of the thread.
export const CODEX_INJECT_PREPARES_IMAGES_FROM = '0.142.0'

/** Whether Codex resizes an injected image before recording it; an unknown version does not. */
export function codexInjectPreparesImages(codexVersion: string | null | undefined): boolean {
  return codexVersion
    ? hasReachedAppVersion(codexVersion, CODEX_INJECT_PREPARES_IMAGES_FROM)
    : false
}

type CodexImageReads = {
  /** Source bytes the inject may still read. */
  bytes: number
  /** Off for a Codex that keeps injected images raw. */
  allowed: boolean
  /** The preparation gave up: no further image is read. */
  signal?: AbortSignal
}

/** A local image inline within what the inject has left; null for one left out: no longer read,
 *  too slow to read, past the budget, or a remote URL, which Codex refuses in injected items. */
async function inlineImage(
  block: Extract<NativeChatBlock, { type: 'image-ref' }>,
  reads: CodexImageReads
): Promise<Record<string, unknown> | null> {
  const path = block.path
  const mimeType = path ? IMAGE_FILE_MIME_TYPES[extname(path).toLowerCase()] : undefined
  if (!reads.allowed || block.url || !path || !mimeType || !INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return null
  }
  const bytes = await readStoppedImage(
    path,
    () => readClaudeImage(path, open, reads.bytes),
    reads.signal
  )
  if (!bytes) {
    return null
  }
  reads.bytes -= bytes.byteLength
  return {
    type: 'input_image',
    image_url: `data:${mimeType};base64,${bytes.toString('base64')}`
  }
}

/** The message's words and images as Codex response content, in the order sent, less any image
 *  left out. */
async function messageContent(
  body: AgentJournalMessageItem,
  reads: CodexImageReads
): Promise<Record<string, unknown>[]> {
  const content: Record<string, unknown>[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image-ref') {
      const image = await inlineImage(block, reads)
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

/** The items one inject writes: each stopped message, then Codex's own record of its Stop. A
 *  message left with nothing is null there. */
async function codexStoppedMessageItems(
  messages: readonly OwedStoppedMessage[],
  images: Omit<CodexImageReads, 'bytes'>
): Promise<(Record<string, unknown>[] | null)[]> {
  const reads = { ...images, bytes: CODEX_STOPPED_MESSAGE_IMAGE_MAX_BYTES }
  const items: (Record<string, unknown>[] | null)[] = []
  for (const { body } of messages) {
    const content = await messageContent(body, reads)
    items.push(
      content.length > 0
        ? [
            userMessage(content),
            userMessage([{ type: 'input_text', text: CODEX_TURN_ABORTED_MARKER }])
          ]
        : null
    )
  }
  return items
}

/** The session state an inject reads. */
export type CodexInjectHost = Pick<
  CodexSession,
  'ended' | 'fence' | 'threadId' | 'activeTurnIds' | 'dispatchPending'
> & {
  connection: Pick<CodexSession['connection'], 'closed' | 'request' | 'codexVersion'>
}

/** Why Codex cannot take an inject now, or null: gone, or a turn running by its own account. */
export function codexStoppedMessageAppendBusy(session: CodexInjectHost | undefined): string | null {
  if (!session || session.ended || session.connection.closed) {
    return 'Codex ended before the append'
  }
  return session.activeTurnIds?.size || session.dispatchPending ? 'Codex is running a turn' : null
}

/** How a Codex session takes stopped messages now: appended, or none while it is busy. */
export function codexAppendDelivery(
  session: CodexInjectHost | undefined
): AgentSessionStoppedMessageDelivery {
  return codexStoppedMessageAppendBusy(session) ? 'none' : 'append'
}

/** Why the inject may not go in now, or null when it may: the same live child, connection and
 *  fence, and no turn running by Codex's account or Orca's. */
function notIdle(
  session: CodexInjectHost | undefined,
  entry: { session: CodexInjectHost; connection: CodexInjectHost['connection'] },
  input: { fence: number; turnLive: () => boolean }
): string | null {
  if (
    session !== entry.session ||
    session.connection !== entry.connection ||
    session.fence !== input.fence
  ) {
    return 'Codex ended before the append'
  }
  return (
    codexStoppedMessageAppendBusy(session) ?? (input.turnLive() ? 'Codex is running a turn' : null)
  )
}

export async function injectCodexStoppedMessages(
  current: () => CodexInjectHost | undefined,
  input: { fence: number; messages: readonly OwedStoppedMessage[]; turnLive: () => boolean },
  timeoutMs = {
    prepare: CODEX_STOPPED_MESSAGE_PREPARE_TIMEOUT_MS,
    settle: CODEX_STOPPED_MESSAGE_APPEND_TIMEOUT_MS
  }
): Promise<AgentSessionStoppedMessageAppendOutcome> {
  const session = current()
  if (!session) {
    return { outcome: 'refused', reason: 'Codex ended before the append' }
  }
  const entry = { session, connection: session.connection }
  const before = notIdle(current(), entry, input)
  if (before) {
    return { outcome: 'refused', reason: before }
  }
  const giveUp = new AbortController()
  const images = {
    allowed: codexInjectPreparesImages(entry.connection.codexVersion),
    signal: giveUp.signal
  }
  const read = await withTimeout(
    codexStoppedMessageItems(input.messages, images),
    timeoutMs.prepare,
    null
  )
  // Past the bound the words go alone, which reads nothing, if every message still has some.
  giveUp.abort()
  const messages = read ?? (await codexStoppedMessageItems(input.messages, images))
  if (!read && messages.includes(null)) {
    return { outcome: 'refused', reason: 'reading the stopped messages took too long' }
  }
  const items = messages.flatMap((message) => message ?? [])
  if (items.length === 0) {
    return { outcome: 'unreadable' }
  }
  const now = notIdle(current(), entry, input)
  if (now) {
    return { outcome: 'refused', reason: now }
  }
  try {
    await entry.connection.request(
      'thread/inject_items',
      { threadId: session.threadId, items },
      { timeoutMs: timeoutMs.settle }
    )
    return { outcome: 'accepted' }
  } catch (error) {
    // No error proves nothing was recorded: Codex may record items and then fail. A Codex without
    // the method lands here too, so it is never asked again, as on a build that never appended.
    return {
      outcome: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}
