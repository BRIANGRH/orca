// Stopped messages written into Claude's own log run no turn: each is two `shouldQuery:false`
// frames, and the zero-turn commands Claude runs for them (frames as 2.1.280 sends them, measured)
// open no turn, show no Working and write no row.

import { describe, expect, it, vi } from 'vitest'
import type * as ClaudeDispatchContent from './claude-structured-dispatch-content'
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
import { claudeStoppedMessageContent } from './claude-structured-dispatch-content'
import { settleClaudeExitedSession } from './claude-structured-session-close'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  adapterFor,
  fakeClaude,
  identityFor,
  type FakeConnection
} from './claude-structured-session-test-support'

vi.mock('./claude-structured-dispatch-content', async (original) => {
  const actual = await original<typeof ClaudeDispatchContent>()
  return { ...actual, claudeStoppedMessageContent: vi.fn(actual.claudeStoppedMessageContent) }
})

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
  const session = adapter['sessions'].get('session-1')!
  return { adapter, bodies, connection, frame, session }
}

function append(
  adapter: Awaited<ReturnType<typeof acquired>>['adapter'],
  messages: OwedStoppedMessage[],
  sessionId = 'session-1'
) {
  return adapter.appendStoppedMessages({ sessionId, fence: 7, messages, turnLive: () => false })
}

function turnRunning(bodies: Map<string, AgentJournalItemBody>): boolean {
  return turnRows(bodies).some((body) => readAgentJournalTurn(body)?.state === 'running')
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
    const outcome = append(adapter, [
      stopped('a', 'delete the build'),
      stopped('b', 'then rebuild')
    ])
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
    const outcome = append(adapter, [stopped('a', 'delete the build')])
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
    const outcome = append(adapter, [stopped('a', 'delete the build')])
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

  it('is unknown when Claude does not confirm it in time; then it holds nothing, and its late result ends no turn', async () => {
    const { adapter, bodies, connection, frame, session } = await acquired()
    expect(
      await appendClaudeStoppedMessages(
        session,
        { fence: 7, messages: [stopped('a', 'delete the build')], turnLive: () => false },
        { prepare: 2_000, settle: 10 }
      )
    ).toEqual({ outcome: 'unknown', reason: 'Claude did not confirm the append' })
    expect(connection.sent).toHaveLength(2)
    // Disarmed: the child may rest.
    expect(adapter.holdsDispatch('session-1')).toBe(false)
    const [content, marker] = connection.sent.map((message) => String(message.uuid))

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
    expect(turnRunning(bodies)).toBe(true)
    // The append's own frames, late, while the send's turn runs.
    frame(result(content!))
    frame(lifecycle(content!, 'completed'))
    frame(result(marker!))
    expect(turnRunning(bodies)).toBe(true)
  })

  it("never opens the next send's turn on the timed-out append's late echo, even with the same words", async () => {
    const { adapter, bodies, connection, frame, session } = await acquired()
    expect(
      await appendClaudeStoppedMessages(
        session,
        { fence: 7, messages: [stopped('a', 'ship it')], turnLive: () => false },
        { prepare: 2_000, settle: 10 }
      )
    ).toEqual({ outcome: 'unknown', reason: 'Claude did not confirm the append' })
    const appendedContent = connection.sent[0]!

    // The next send says the same words, so only the uuid tells the two echoes apart.
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'next',
      body: USER_MESSAGE,
      fence: 7
    })
    const sent = connection.sent.at(-1)!
    frame({ ...appendedContent, isReplay: true })
    expect(turnRunning(bodies)).toBe(false)

    frame(lifecycle(String(sent.uuid), 'started'))
    frame(init)
    frame({ ...sent, isReplay: true })
    expect(turnRunning(bodies)).toBe(true)
  })

  it('gives up on a stalled read in time, refused, and never writes it later', async () => {
    const { connection, session } = await acquired()
    let readLate: (content: unknown[]) => void = () => {}
    vi.mocked(claudeStoppedMessageContent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          readLate = resolve
        })
    )
    const started = Date.now()
    expect(
      await appendClaudeStoppedMessages(
        session,
        { fence: 7, messages: [stopped('a', 'look')], turnLive: () => false },
        { prepare: 50, settle: 50 }
      )
    ).toEqual({ outcome: 'refused', reason: 'reading the stopped messages took too long' })
    expect(Date.now() - started).toBeLessThan(1_000)
    readLate([{ type: 'text', text: 'look' }])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connection.sent).toHaveLength(0)
  })

  it('checks again right before the write: refused when the child or Orca moved on while it read', async () => {
    for (const moved of [
      (state: { live: boolean; session: { fence: number } }) => {
        state.live = true
      },
      (state: { live: boolean; session: { fence: number } }) => {
        state.session.fence = 8
      }
    ]) {
      const { connection, session } = await acquired()
      const state = { live: false, session }
      vi.mocked(claudeStoppedMessageContent).mockImplementationOnce(async () => {
        moved(state)
        return [{ type: 'text', text: 'look' }]
      })
      expect(
        await appendClaudeStoppedMessages(session, {
          fence: 7,
          messages: [stopped('a', 'look')],
          turnLive: () => state.live
        })
      ).toMatchObject({ outcome: 'refused' })
      expect(connection.sent).toHaveLength(0)
    }
  })

  it('is refused when the child ends with every frame unwritten, settled as its exit runs', async () => {
    const { adapter, connection, session } = await acquired()
    const writes: ((error: Error) => void)[] = []
    vi.spyOn(connection, 'send').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          writes.push(reject)
        })
    )
    const outcome = append(adapter, [stopped('a', 'delete the build')])
    await vi.waitFor(() => expect(writes).toHaveLength(2))

    // As the connection ends: the queue fails each frame it never wrote, then the exit settles.
    const ended = new Error('claude stream-json connection closed')
    writes.forEach((reject) => reject(claudeUnwrittenUserMessageError(ended)))
    connection.closed = true
    settleClaudeExitedSession(session)

    expect(await outcome).toEqual({ outcome: 'refused', reason: 'Claude took no frame' })
  })

  it('is unknown when the child ends after taking its frames', async () => {
    const { adapter, connection, session } = await acquired()
    const outcome = append(adapter, [stopped('a', 'delete the build')])
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2))

    connection.closed = true
    settleClaudeExitedSession(session)

    expect(await outcome).toEqual({ outcome: 'unknown', reason: 'Claude ended during the append' })
  })

  it('is refused when Claude is gone or took no frame, so the message stays owed', async () => {
    const { adapter, connection } = await acquired()
    vi.spyOn(connection, 'send').mockRejectedValue(
      claudeUnwrittenUserMessageError(new Error('claude stream-json connection is closed'))
    )
    expect(await append(adapter, [stopped('a', 'delete the build')])).toMatchObject({
      outcome: 'refused'
    })
    expect(await append(adapter, [stopped('a', 'delete the build')], 'gone')).toMatchObject({
      outcome: 'refused'
    })
  })

  it('waits out a background wake: refused while Claude runs a cycle Orca opened no turn for, then goes once idle', async () => {
    const { adapter, connection, frame } = await acquired()
    // Fresh: Claude reports no state until its first command, which reads as idle.
    expect(adapter.stoppedMessageDelivery('session-1')).toBe('append')
    // A background task woke Claude: a cycle runs, with no output yet and no turn in Orca.
    frame(running)
    frame(init)
    expect(adapter.stoppedMessageDelivery('session-1')).toBe('none')
    expect(await append(adapter, [stopped('a', 'delete the build')])).toEqual({
      outcome: 'refused',
      reason: 'Claude is not idle'
    })
    expect(connection.sent).toHaveLength(0)

    frame(idle)
    expect(adapter.stoppedMessageDelivery('session-1')).toBe('append')
    const outcome = append(adapter, [stopped('a', 'delete the build')])
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
    for (const message of connection.sent) {
      frame(result(String(message.uuid)))
    }
    expect(await outcome).toEqual({ outcome: 'accepted' })
  })

  it('is unknown when a frame may have been written and the rest failed', async () => {
    const { adapter, connection } = await acquired()
    vi.spyOn(connection, 'send')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('stdin closed mid-write'))
    expect(await append(adapter, [stopped('a', 'delete the build')])).toMatchObject({
      outcome: 'unknown'
    })
  })
})
