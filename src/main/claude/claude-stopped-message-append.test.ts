// Stopped messages written into Claude's own log run no turn: each is two `shouldQuery:false`
// frames, and the zero-turn commands Claude runs for them (frames as 2.1.280 sends them, measured)
// open no turn, show no Working and write no row.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../shared/agent-session-stopped-history'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import { appendClaudeStoppedMessages } from './claude-stopped-message-append'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  adapterFor,
  fakeClaude,
  identityFor,
  type FakeConnection
} from './claude-structured-session-test-support'

function stopped(id: string, text: string): OwedStoppedMessage {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  }
  return {
    body,
    submission: {
      clientMessageId: id,
      fence: 7,
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

async function acquired() {
  const claude = fakeClaude({ replayUuid: null, initProof: 'none' })
  const bodies = new Map<string, AgentJournalItemBody>()
  const adapter = adapterFor(claude)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: (identity, body) => bodies.set(agentJournalItemKey(identity), body),
      appendTombstone: (identity) => bodies.delete(agentJournalItemKey(identity)),
      publish: vi.fn()
    }
  })
  const connection = claude.connections[0]!
  const frame = (message: Record<string, unknown>) =>
    connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  return { adapter, bodies, connection, frame }
}

/** The rows a turn writes: its turn record and the messages in it. */
function turnRows(bodies: Map<string, AgentJournalItemBody>): AgentJournalItemBody[] {
  return [...bodies.values()].filter(
    (body) => body.kind === 'message' || readAgentJournalTurn(body) !== null
  )
}

const running = { type: 'system', subtype: 'session_state_changed', state: 'running' }
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' }
const init = { type: 'system', subtype: 'init', uuid: 'init', model: 'claude-sonnet-5' }
const lifecycle = (uuid: string, state: string) => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state,
  uuid: `${uuid}-${state}`
})
const result = (uuid: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  result: '',
  uuid: `${uuid}-result`,
  user_message_uuid: uuid,
  user_message_uuids: [uuid]
})

/** One appended message as Claude runs it: the content frame echoed, the marker never. */
function zeroTurnCommands(
  connection: FakeConnection,
  frame: (message: Record<string, unknown>) => void
): void {
  const [content, marker] = connection.sent.map((message) => String(message.uuid))
  frame(running)
  frame(lifecycle(content!, 'queued'))
  frame(lifecycle(content!, 'started'))
  frame(lifecycle(marker!, 'queued'))
  frame(init)
  frame({ ...connection.sent[0], isReplay: true, parent_tool_use_id: null })
  frame(result(content!))
  frame(lifecycle(content!, 'completed'))
  frame(lifecycle(marker!, 'started'))
  frame(init)
  frame(result(marker!))
  frame(lifecycle(marker!, 'completed'))
}

describe('appending stopped messages to Claude', () => {
  it('writes each as its content then the block-form marker, shouldQuery false, oldest first', async () => {
    const { adapter, connection, frame } = await acquired()
    const outcome = adapter.appendStoppedMessages({
      sessionId: 'session-1',
      fence: 7,
      messages: [stopped('a', 'delete the build'), stopped('b', 'then rebuild')]
    })
    await vi.waitFor(() => expect(connection.sent).toHaveLength(4))

    expect(connection.sent.map(({ uuid: _uuid, ...rest }) => rest)).toEqual(
      [
        'delete the build',
        '[Request interrupted by user]',
        'then rebuild',
        '[Request interrupted by user]'
      ].map((text) => ({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: PROVIDER_SESSION_ID,
        shouldQuery: false
      }))
    )
    expect(new Set(connection.sent.map((message) => message.uuid)).size).toBe(4)
    for (const message of connection.sent) {
      frame(result(String(message.uuid)))
    }
    expect(await outcome).toEqual({ outcome: 'accepted' })
  })

  it('settles once Claude completes every frame, and its commands open no turn, Working or row', async () => {
    const { adapter, bodies, connection, frame } = await acquired()
    const outcome = adapter.appendStoppedMessages({
      sessionId: 'session-1',
      fence: 7,
      messages: [stopped('a', 'delete the build')]
    })
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
    expect(adapter.holdsDispatch('session-1')).toBe(true)
    const before = [...bodies]

    zeroTurnCommands(connection, frame)
    expect(await outcome).toEqual({ outcome: 'accepted' })
    frame(idle)

    // Not a row of any kind: no turn, no message, no provider frame.
    expect([...bodies]).toEqual(before)
    expect(adapter.holdsDispatch('session-1')).toBe(false)
    // The next send opens its own turn as ever.
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'next',
      body: USER_MESSAGE,
      fence: 7
    })
    const sent = connection.sent.at(-1)!
    frame(lifecycle(String(sent.uuid), 'started'))
    frame(init)
    frame({ ...sent, isReplay: true })
    expect(turnRows(bodies).some((body) => readAgentJournalTurn(body)?.state === 'running')).toBe(
      true
    )
  })

  it('leaves a send that starts before the append idles its own frames, its idle included', async () => {
    const { adapter, bodies, connection, frame } = await acquired()
    const outcome = adapter.appendStoppedMessages({
      sessionId: 'session-1',
      fence: 7,
      messages: [stopped('a', 'delete the build')]
    })
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
    zeroTurnCommands(connection, frame)
    expect(await outcome).toEqual({ outcome: 'accepted' })

    // Queued behind the append, so Claude runs it in the same busy spell with no idle between.
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'next',
      body: USER_MESSAGE,
      fence: 7
    })
    const sent = connection.sent.at(-1)!
    frame(lifecycle(String(sent.uuid), 'started'))
    frame(init)
    frame({ ...sent, isReplay: true })
    expect(turnRows(bodies).some((body) => readAgentJournalTurn(body)?.state === 'running')).toBe(
      true
    )
    frame(idle)
    expect(turnRows(bodies).some((body) => readAgentJournalTurn(body)?.state === 'running')).toBe(
      false
    )
  })

  it('is unknown when Claude does not confirm it in time, and never claims a later turn for it', async () => {
    const { adapter, connection } = await acquired()
    const session = adapter['sessions'].get('session-1')!
    expect(
      await appendClaudeStoppedMessages(session, [stopped('a', 'delete the build')], 10)
    ).toEqual({ outcome: 'unknown', reason: 'Claude did not confirm the append' })
    expect(connection.sent).toHaveLength(2)
  })

  it('is refused when Claude is gone or took no frame, so the message stays owed', async () => {
    const { adapter, connection } = await acquired()
    vi.spyOn(connection, 'send').mockRejectedValue(
      claudeUnwrittenUserMessageError(new Error('claude stream-json connection is closed'))
    )
    expect(
      await adapter.appendStoppedMessages({
        sessionId: 'session-1',
        fence: 7,
        messages: [stopped('a', 'delete the build')]
      })
    ).toMatchObject({ outcome: 'refused' })
    expect(
      await adapter.appendStoppedMessages({
        sessionId: 'gone',
        fence: 7,
        messages: [stopped('a', 'delete the build')]
      })
    ).toMatchObject({ outcome: 'refused' })
  })

  it('is unknown when a frame may have been written and the rest failed', async () => {
    const { adapter, connection } = await acquired()
    vi.spyOn(connection, 'send')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('stdin closed mid-write'))
    expect(
      await adapter.appendStoppedMessages({
        sessionId: 'session-1',
        fence: 7,
        messages: [stopped('a', 'delete the build')]
      })
    ).toMatchObject({ outcome: 'unknown' })
  })
})
