// Stopped messages written into Claude's own log without running a turn: per message, its content
// and then the block-form `[Request interrupted by user]` Claude writes for its own Stop, each a
// `shouldQuery:false` frame, all queued back to back. Claude runs each frame as a zero-turn command
// (measured, 2.1.280): `running`, then per frame `queued`, `started`, `system/init`, an echo of the
// content frame only, `result` naming its uuid and `completed`, then `idle`. Those frames are the
// append's, never a turn's: claimed here, they open no turn, show no Working and write no row.

import { randomUUID } from 'node:crypto'
import type { AgentSessionStoppedMessageAppendOutcome } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-adapter'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { claudeUserMessageWasProvablyUnwritten } from './claude-agent-sdk-user-message-queue'
import { claudeStoppedMessageContent } from './claude-structured-dispatch-content'
import { readClaudeFrameString } from './claude-structured-init-proof'
import type { ClaudeSession } from './claude-structured-session-state'

export const CLAUDE_INTERRUPTED_MARKER = '[Request interrupted by user]'
const CLAUDE_STOPPED_MESSAGE_APPEND_TIMEOUT_MS = 5_000

/** An append Claude has not finished: its frames are claimed until its own `idle`. */
export type ClaudeStoppedMessageAppend = {
  uuids: ReadonlySet<string>
  /** Uuids Claude reported completing. */
  settled: Set<string>
  /** Whether the command Claude started last is this append's; null before any started. */
  runningOwn: boolean | null
  finish: (outcome: AgentSessionStoppedMessageAppendOutcome) => void
}

function frame(session: ClaudeSession, content: readonly unknown[]): Record<string, unknown> {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: session.providerSessionId,
    shouldQuery: false
  }
}

export async function appendClaudeStoppedMessages(
  session: ClaudeSession | undefined,
  messages: readonly OwedStoppedMessage[],
  timeoutMs = CLAUDE_STOPPED_MESSAGE_APPEND_TIMEOUT_MS
): Promise<AgentSessionStoppedMessageAppendOutcome> {
  if (!session || session.connection.closed) {
    return { outcome: 'refused', reason: 'Claude ended before the append' }
  }
  const frames: Record<string, unknown>[] = []
  for (const { body } of messages) {
    const content = await claudeStoppedMessageContent(body)
    if (content) {
      frames.push(
        frame(session, content),
        frame(session, [{ type: 'text', text: CLAUDE_INTERRUPTED_MARKER }])
      )
    }
  }
  if (frames.length === 0) {
    return { outcome: 'unknown', reason: 'nothing readable to append' }
  }
  let finish: ClaudeStoppedMessageAppend['finish'] = () => {}
  const settled = new Promise<AgentSessionStoppedMessageAppendOutcome>((resolve) => {
    finish = resolve
  })
  const append: ClaudeStoppedMessageAppend = {
    uuids: new Set(frames.map((entry) => String(entry.uuid))),
    settled: new Set(),
    runningOwn: null,
    finish: (outcome) => finish(outcome)
  }
  session.stoppedMessageAppend?.finish({ outcome: 'unknown', reason: 'a later append replaced it' })
  session.stoppedMessageAppend = append
  const timer = setTimeout(
    () => append.finish({ outcome: 'unknown', reason: 'Claude did not confirm the append' }),
    timeoutMs
  )
  // Queued in one go, so nothing can come between them.
  void Promise.allSettled(frames.map((entry) => session.connection.send(entry))).then((writes) => {
    const failed = writes.flatMap((write) => (write.status === 'rejected' ? [write.reason] : []))
    if (failed.length === writes.length && failed.every(claudeUserMessageWasProvablyUnwritten)) {
      // No frame will come, so none is left to claim.
      endClaudeStoppedMessageAppend(session, { outcome: 'refused', reason: 'Claude took no frame' })
    } else if (failed.length > 0) {
      append.finish({ outcome: 'unknown', reason: String(failed[0]) })
    }
  })
  try {
    return await settled
  } finally {
    clearTimeout(timer)
  }
}

/** Ends the append Claude is running, with `outcome` unless it already settled. */
export function endClaudeStoppedMessageAppend(
  session: ClaudeSession,
  outcome: AgentSessionStoppedMessageAppendOutcome = {
    outcome: 'unknown',
    reason: 'Claude ended during the append'
  }
): void {
  const append = session.stoppedMessageAppend
  if (append) {
    session.stoppedMessageAppend = null
    append.finish(outcome)
  }
}

function settle(append: ClaudeStoppedMessageAppend, uuids: readonly string[]): void {
  uuids.forEach((uuid) => append.settled.add(uuid))
  if (append.settled.size === append.uuids.size) {
    append.finish({ outcome: 'accepted' })
  }
}

function resultUuids(message: Record<string, unknown>): string[] {
  const uuids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string')
    : []
  const one = readClaudeFrameString(message, 'user_message_uuid')
  return uuids.length > 0 ? uuids : one ? [one] : []
}

/** Whether `message` is a frame of the append Claude is running, which no turn may read. Frames
 *  naming a uuid are claimed by it; `running`, `system/init` and `idle` name none, so they are the
 *  append's while the command Claude started last is. */
export function claimClaudeStoppedMessageAppendFrame(
  session: ClaudeSession,
  message: Record<string, unknown>
): boolean {
  const append = session.stoppedMessageAppend
  if (!append) {
    return false
  }
  if (message.type === 'command_lifecycle') {
    const uuid = readClaudeFrameString(message, 'command_uuid')
    const own = uuid !== null && append.uuids.has(uuid)
    if (message.state === 'started') {
      append.runningOwn = own
    }
    if (own && message.state === 'completed') {
      settle(append, [uuid])
    } else if (own && message.state !== 'queued' && message.state !== 'started') {
      append.finish({
        outcome: 'unknown',
        reason: `Claude ended an appended frame: ${String(message.state)}`
      })
    }
    return own
  }
  if (message.type === 'result') {
    const uuids = resultUuids(message)
    const own = uuids.length > 0 && uuids.every((uuid) => append.uuids.has(uuid))
    if (own) {
      settle(append, uuids)
    }
    return own
  }
  if (message.type === 'user') {
    const uuid = readClaudeFrameString(message, 'uuid')
    return uuid !== null && append.uuids.has(uuid)
  }
  if (message.type !== 'system') {
    return false
  }
  const own = append.runningOwn !== false
  if (message.subtype === 'session_state_changed' && message.state === 'idle') {
    endClaudeStoppedMessageAppend(session)
    return own
  }
  return (
    own &&
    (message.subtype === 'init' ||
      (message.subtype === 'session_state_changed' && message.state === 'running'))
  )
}
