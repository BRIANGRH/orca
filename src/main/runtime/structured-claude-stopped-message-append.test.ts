// A message a Stop withdrew while Claude started goes into Claude's own log as its two
// shouldQuery:false frames, with its record, right ahead of the next send. Against the production
// runtime, adapter router, Claude adapter, record store and host, with only the CLI scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { agentSessionMessagePayload } from '../../shared/structured-agent-session-send-mutation'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createScriptedClaudeRuntime,
  type ScriptedClaudeChild
} from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-stopped-message-append'
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

function envelope(
  host: StructuredAgentSessionHost,
  method: string,
  fields: Record<string, unknown>
) {
  return {
    sessionId: SESSION,
    // The runtime's own clock admits operation ids, so these are minted against it.
    clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const fields = { body: agentSessionMessagePayload(body) }
  const request = { envelope: envelope(host, 'agentSession.send', fields), ...fields, body }
  expect(await host.send(CALLER, { ...request, userSend: true })).toMatchObject({ ok: true })
  return request.envelope.clientOperationId
}

/** The user frames `child`'s stdin takes. */
function recordStdin(child: ScriptedClaudeChild): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  vi.spyOn(child.connection, 'send').mockImplementation(async (message, beforeDispatch) => {
    await beforeDispatch?.()
    frames.push(message)
  })
  return frames
}

/** Each frame's words, marked when it runs no query. */
function words(frames: readonly Record<string, unknown>[]): string[] {
  return frames.map((frame) => {
    const message = frame.message
    const content =
      typeof message === 'object' && message !== null && 'content' in message
        ? message.content
        : null
    const text = Array.isArray(content)
      ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
      : ''
    return frame.shouldQuery === false ? `${text} (no query)` : text
  })
}

describe("a stopped message goes into Claude's own log", () => {
  it('appends it with its record, ahead of the next send', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    expect(await host.attach(CALLER, claude.attachParams(SESSION, null))).toMatchObject({
      ok: true
    })
    const journal = () => host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const phase = () => host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase

    // Sent while Claude starts, then stopped: withdrawn, never written.
    await vi.waitFor(() => expect(phase()).toBe('starting'))
    const firstStdin = recordStdin(claude.child(SESSION))
    const stopped = await send(host, 'delete the build folder')
    expect(
      await host.cancel(CALLER, { envelope: envelope(host, 'agentSession.cancel', {}) })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(
        journal()
          .submissions()
          .find((entry) => entry.clientMessageId === stopped)
      ).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'cancelled', neverReachedAgent: true }
      })
    )
    expect(firstStdin).toEqual([])

    // The next send starts a new Claude, which takes the stopped message first.
    await send(host, 'what did I send?')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))
    const next = claude.child(SESSION)
    const stdin = recordStdin(next)
    next.answerInit()
    await vi.waitFor(() => expect(stdin).toHaveLength(2), { timeout: 5_000 })
    expect([...journal().stoppedHistory.appended().values()]).toEqual([
      expect.objectContaining({ messageIds: [stopped] })
    ])
    // Claude runs each as a zero-turn command and names its uuid when done.
    for (const frame of stdin.slice(0, 2)) {
      next.handlers.onMessage?.({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 0,
        result: '',
        session_id: claudeSessionIdForOrcaSession(SESSION),
        uuid: `${String(frame.uuid)}-result`,
        user_message_uuids: [frame.uuid]
      })
    }
    await vi.waitFor(() => expect(stdin).toHaveLength(3))
    expect(words(stdin)).toEqual([
      'delete the build folder (no query)',
      '[Request interrupted by user] (no query)',
      'what did I send?'
    ])
  })
})
