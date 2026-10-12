// Stopped messages written into Claude's own log without running a turn: per message, its content
// and then the block-form `[Request interrupted by user]` Claude writes for its own Stop, each a
// `shouldQuery:false` frame, all queued back to back. Claude runs each frame as a zero-turn command
// (measured, 2.1.280): `running`, then per frame `queued`, `started`, `system/init`, an echo of the
// content frame only, `result` naming its uuid and `completed`, then `idle`. The frames naming its
// uuids are the append's, never a turn's; the rest open no turn on their own.

import { randomUUID } from 'node:crypto'
import type { AgentSessionStoppedMessageAppendOutcome } from '../native-chat/agent-session-wire/structured-agent-session-stopped-history-adapter'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { claudeUserMessageWasProvablyUnwritten } from './claude-agent-sdk-user-message-queue'
import { claudeStoppedMessageContent } from './claude-structured-dispatch-content'
import { readClaudeFrameString } from './claude-structured-init-proof'
import type { ClaudeSession } from './claude-structured-session-state'

export const CLAUDE_INTERRUPTED_MARKER = '[Request interrupted by user]'
// Each bound alone keeps a send queued behind the append waiting at most a few seconds.
const CLAUDE_STOPPED_MESSAGE_PREPARE_TIMEOUT_MS = 2_000
const CLAUDE_STOPPED_MESSAGE_APPEND_TIMEOUT_MS = 2_000

/** The last append: armed (`finish`) until it settles; its uuids stay after, so a late frame of
 *  its own is still never read as a turn's. */
export type ClaudeStoppedMessageAppend = {
  uuids: ReadonlySet<string>
  /** Uuids Claude reported completing. */
  settled: Set<string>
  finish: ((outcome: AgentSessionStoppedMessageAppendOutcome) => void) | null
  /** The child ended: settled from what its writes prove. */
  end: () => void
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

function finish(
  append: ClaudeStoppedMessageAppend,
  outcome: AgentSessionStoppedMessageAppendOutcome
): void {
  const settle = append.finish
  append.finish = null
  settle?.(outcome)
}

/** What the writes prove once all settled: null when every frame was written. */
function writeProof(
  writes: readonly PromiseSettledResult<unknown>[]
): AgentSessionStoppedMessageAppendOutcome | null {
  const failed = writes.flatMap((write) => (write.status === 'rejected' ? [write.reason] : []))
  if (failed.length === writes.length && failed.every(claudeUserMessageWasProvablyUnwritten)) {
    return { outcome: 'refused', reason: 'Claude took no frame' }
  }
  return failed.length > 0 ? { outcome: 'unknown', reason: String(failed[0]) } : null
}

/** Why Claude cannot take an append now, or null: gone, or running a command of its own, such as
 *  a background task's wake, which opens no turn in Orca. No state yet is idle: Claude reports
 *  none until its first command (measured). */
export function claudeStoppedMessageAppendBusy(session: ClaudeSession | undefined): string | null {
  if (!session || session.connection.closed) {
    return 'Claude ended before the append'
  }
  return session.providerState === undefined || session.providerState === 'idle'
    ? null
    : 'Claude is not idle'
}

/** Why the append may not go in now, or null when it may. */
function notReady(
  session: ClaudeSession | undefined,
  input: { fence: number; turnLive: () => boolean }
): string | null {
  if (session && session.fence !== input.fence) {
    return 'Claude ended before the append'
  }
  return (
    claudeStoppedMessageAppendBusy(session) ??
    (input.turnLive() ? 'Claude is running a turn' : null)
  )
}

export async function appendClaudeStoppedMessages(
  session: ClaudeSession | undefined,
  input: { fence: number; messages: readonly OwedStoppedMessage[]; turnLive: () => boolean },
  timeoutMs = {
    prepare: CLAUDE_STOPPED_MESSAGE_PREPARE_TIMEOUT_MS,
    settle: CLAUDE_STOPPED_MESSAGE_APPEND_TIMEOUT_MS
  }
): Promise<AgentSessionStoppedMessageAppendOutcome> {
  const before = notReady(session, input)
  if (!session || before) {
    return { outcome: 'refused', reason: before ?? 'Claude ended before the append' }
  }
  const contents = await withTimeout<(unknown[] | null)[] | null>(
    Promise.all(input.messages.map(({ body }) => claudeStoppedMessageContent(body))),
    timeoutMs.prepare,
    null
  )
  // Past here nothing awaits before the write, so preparation abandoned above never writes.
  if (!contents) {
    return { outcome: 'refused', reason: 'reading the stopped messages took too long' }
  }
  const now = notReady(session, input)
  if (now) {
    return { outcome: 'refused', reason: now }
  }
  const frames = contents.flatMap((content) =>
    content
      ? [
          frame(session, content),
          frame(session, [{ type: 'text', text: CLAUDE_INTERRUPTED_MARKER }])
        ]
      : []
  )
  if (frames.length === 0) {
    return { outcome: 'unreadable' }
  }
  const append: ClaudeStoppedMessageAppend = {
    uuids: new Set(frames.map((entry) => String(entry.uuid))),
    settled: new Set(),
    finish: null,
    end: () => {}
  }
  const settled = new Promise<AgentSessionStoppedMessageAppendOutcome>((resolve) => {
    append.finish = resolve
  })
  if (session.stoppedMessageAppend) {
    finish(session.stoppedMessageAppend, {
      outcome: 'unknown',
      reason: 'a later append replaced it'
    })
  }
  session.stoppedMessageAppend = append
  // Queued in one go, so nothing can come between them.
  const writes = Promise.allSettled(frames.map((entry) => session.connection.send(entry)))
  // One settlement for a failed write and for an ended child: an ended child confirms nothing, so
  // a frame it took is unknown and one it provably never took is refused.
  const settleFromWrites = (ended: boolean): void =>
    void writes.then((results) => {
      const proof =
        writeProof(results) ??
        (ended ? { outcome: 'unknown' as const, reason: 'Claude ended during the append' } : null)
      if (proof) {
        finish(append, proof)
      }
    })
  append.end = () => settleFromWrites(true)
  settleFromWrites(false)
  const outcome = await withTimeout(settled, timeoutMs.settle, {
    outcome: 'unknown',
    reason: 'Claude did not confirm the append'
  })
  // Disarmed on a timeout too, so the child may rest.
  append.finish = null
  return outcome
}

/** The child ended: the append Claude was running settles from what its writes prove. */
export function endClaudeStoppedMessageAppend(session: ClaudeSession): void {
  session.stoppedMessageAppend?.end()
}

/** Whether an append is still waiting for Claude, which holds the child from rest. */
export function claudeStoppedMessageAppendArmed(session: ClaudeSession): boolean {
  return Boolean(session.stoppedMessageAppend?.finish)
}

function settle(append: ClaudeStoppedMessageAppend, uuids: readonly string[]): void {
  uuids.forEach((uuid) => append.settled.add(uuid))
  if (append.settled.size === append.uuids.size) {
    finish(append, { outcome: 'accepted' })
  }
}

function resultUuids(message: Record<string, unknown>): string[] {
  const uuids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string')
    : []
  const one = readClaudeFrameString(message, 'user_message_uuid')
  return uuids.length > 0 ? uuids : one ? [one] : []
}

/** Whether `message` names the last append's frames (lifecycle, echo, result), which no turn may
 *  read, even after it settled: a late result would end a running turn. */
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
    if (uuid === null || !append.uuids.has(uuid)) {
      return false
    }
    if (message.state === 'completed') {
      settle(append, [uuid])
    } else if (message.state !== 'queued' && message.state !== 'started') {
      finish(append, {
        outcome: 'unknown',
        reason: `Claude ended an appended frame: ${String(message.state)}`
      })
    }
    return true
  }
  if (message.type === 'result') {
    const uuids = resultUuids(message)
    if (uuids.length === 0 || !uuids.every((uuid) => append.uuids.has(uuid))) {
      return false
    }
    settle(append, uuids)
    return true
  }
  const uuid = message.type === 'user' ? readClaudeFrameString(message, 'uuid') : null
  return uuid !== null && append.uuids.has(uuid)
}
