// A rewind keeps a person's stopped messages and what carried them: a stopped message before the
// rewind point keeps its bubble and stays owed unless a send that survives the rewind carried it.
// Against the real host, store and journal, with a Codex-shaped rewind that answers with the items
// its thread still holds.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { RigPreparedDispatch } from './structured-agent-session-queued-message-rig-provider.test-fixture'

let rig: QueuedMessageTestRig
/** What the Codex thread holds, oldest first: each accepted send in the words it received. */
let thread: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]

const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>(
  async ({ beforeTurnId, onPrepared }) => {
    const cut = thread.findIndex(
      ({ identity }) => identity.provider === 'codex' && identity.turnId === beforeTurnId
    )
    const kept = cut === -1 ? thread : thread.slice(0, cut)
    await onPrepared?.(kept)
    thread = kept
    return { ok: true, items: kept }
  }
)

async function start(): Promise<void> {
  thread = []
  rig = await createQueuedMessageTestRig({ restartable: true, starting: true, rewind })
}

afterEach(async () => {
  await rig.dispose()
})

function journal(): AgentSessionJournal {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('the conversation is not open')
  }
  return open
}

function text(body: AgentJournalMessageItem): string {
  return body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** Each dispatch as `carrier <- [history]`, the history as the prepared send carries it. */
function dispatched(): string[] {
  return rig.dispatch.mock.calls.map(([input]) => {
    const prepared = input.prepared instanceof RigPreparedDispatch ? input.prepared : null
    expect(input.prepared === undefined || prepared !== null).toBe(true)
    return prepared ? `${text(input.body)} <- [${prepared.history.join(', ')}]` : text(input.body)
  })
}

/** A Stop while the agent starts: what it held is withdrawn, never written. */
async function stopWhileStarting(body: string): Promise<string> {
  if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child) {
    await rig.host.close(SESSION, 'evict')
  }
  const message = hostTestMessage(body)
  const envelope = rig.envelope({ body: message }, 'agentSession.send', hostTestOperationId())
  expect(
    await rig.host.send(QUEUED_RIG_CALLER, { envelope, body: message, userSend: true })
  ).toMatchObject({ ok: true })
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  expect(await rig.stop()).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig.submission(envelope.clientOperationId)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled', neverReachedAgent: true }
    })
  )
  return envelope.clientOperationId
}

/** A send handed to a child that proved its start; `mail` is another agent's. */
async function nextSend(body: string, mail = false): Promise<string> {
  const before = rig.dispatch.mock.calls.length
  const { id, result } = rig.send(
    body,
    undefined,
    mail ? { internal: true, from: { kind: 'agent', senders: [], orchestration: null } } : {}
  )
  expect(await result).toMatchObject({ ok: true })
  if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase !== 'ready') {
    await rig.proveStart()
  }
  await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
  return id
}

/** The agent took it: Codex now holds it in the words it received. */
async function accepted(id: string, turn: string, received: string): Promise<void> {
  await rig.settleAccepted(id, turn)
  const providerItemId = (await rig.submission(id))?.providerItemId
  const identity = providerItemId ? parseAgentJournalItemKey(providerItemId) : null
  if (!identity) {
    throw new Error(`${id} was not accepted`)
  }
  thread.push({ identity, body: hostTestMessage(received) })
}

async function rewindTo(id: string): Promise<void> {
  const fields = { itemId: agentJournalSubmissionKey(id), expectedEpoch: journal().cursor().epoch }
  expect(
    await rig.host.rewind(QUEUED_RIG_CALLER, {
      ...fields,
      envelope: rig.envelope(fields, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
}

async function clear(): Promise<void> {
  const fields = { command: 'clear' as const }
  expect(
    await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
  ).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
}

/** The texts the desktop (`rejectedInPlace`) and the phone draw, in that order. */
async function transcripts(): Promise<string[][]> {
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return [true, false].map((rejectedInPlace) =>
    projectStructuredAgentSessionMessages(page.page.items, [], page.page.submissions, {
      rejectedInPlace
    }).map(
      (message) =>
        `${message.blocks.map((block) => ('text' in block ? block.text : '')).join('')}${
          message.stoppedBeforeStart ? ' (stopped)' : ''
        }`
    )
  )
}

async function expectStillStopped(id: string): Promise<void> {
  expect(await rig.submission(id)).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'cancelled', neverReachedAgent: true }
  })
}

/** Stop A, then B carries it and the agent takes B (received with A's history ahead of it). */
async function stoppedThenCarried(): Promise<{ stopped: string; carrier: string }> {
  const stopped = await stopWhileStarting('A')
  const carrier = await nextSend('B')
  await accepted(carrier, 'B', 'history A, then B')
  return { stopped, carrier }
}

describe.each([
  { path: 'its own history', cleared: false },
  { path: 'history after a /clear', cleared: true }
])('a rewind of $path keeps stopped messages', ({ cleared }) => {
  async function begin(): Promise<void> {
    await start()
    if (cleared) {
      await clear()
    }
  }

  const shown = (...rows: string[]) => {
    const each = [...(cleared ? ['Context cleared'] : []), ...rows]
    return [each, each]
  }

  /** A rewind after a /clear rebuilds in place; one without starts a new epoch. */
  function expectRebuildPath(epochBefore: string): void {
    expect(journal().cursor().epoch === epochBefore).toBe(cleared)
  }

  it('rewound before the carrier: the stopped message stays and rides with the next send', async () => {
    await begin()
    const { stopped, carrier } = await stoppedThenCarried()
    const epoch = journal().cursor().epoch

    await rewindTo(carrier)

    expectRebuildPath(epoch)
    expect(await transcripts()).toEqual(shown('A (stopped)', 'Stopped manually'))
    await expectStillStopped(stopped)
    const next = await nextSend('C')
    expect(dispatched()).toEqual(['B <- [A]', 'C <- [A]'])
    expect(journal().stoppedHistoryCarried().get(next)).toEqual([stopped])
  })

  it('rewound after the carrier: it stays covered and the carrier draws once, in its own words', async () => {
    await begin()
    const { stopped, carrier } = await stoppedThenCarried()
    const later = await nextSend('C')
    await accepted(later, 'C', 'C')
    const epoch = journal().cursor().epoch

    await rewindTo(later)

    expectRebuildPath(epoch)
    expect(await transcripts()).toEqual(shown('A (stopped)', 'Stopped manually', 'B'))
    await expectStillStopped(stopped)
    expect(journal().stoppedHistoryCarried().get(carrier)).toEqual([stopped])
    await nextSend('D')
    expect(dispatched()).toEqual(['B <- [A]', 'C', 'D'])
  })

  it.each([
    { point: 'before', owed: 'D <- [A]' },
    { point: 'after', owed: 'D' }
  ])(
    'a host restart after a rewind $point the carrier keeps its answer',
    async ({ point, owed }) => {
      await begin()
      const { stopped, carrier } = await stoppedThenCarried()
      const later = await nextSend('C')
      await accepted(later, 'C', 'C')

      await rewindTo(point === 'before' ? carrier : later)
      await rig.restartHostProcess()
      await expectStillStopped(stopped)
      await nextSend('D')

      expect(dispatched().at(-1)).toBe(owed)
    }
  )

  it.each([
    { sends: 'a carrier', mail: false },
    { sends: 'mail only', mail: true }
  ])('a card the person stopped stays paused through a rewind after $sends', async ({ mail }) => {
    await begin()
    await stopWhileStarting('A')
    const carrier = await nextSend('B', mail)
    await accepted(carrier, 'B', mail ? 'B' : 'history A, then B')
    const later = await nextSend('C', mail)
    await accepted(later, 'C', 'C')
    const working = rig.send('W')
    expect(await working.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(working.id))?.handedOverAt).toBeDefined()
    )
    const queued = await rig.send('Q', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleRejected(working.id, 'interrupted')
    const sent = dispatched()

    await rewindTo(later)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(await rig.drafts()).toEqual([
      { messageId: queued.value.queued.messageId, state: 'waiting' }
    ])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(dispatched()).toEqual(sent)
  })

  it('a card held since a restart stays held through a rewind after a carrier', async () => {
    await begin()
    await stoppedThenCarried()
    const later = await nextSend('C')
    await accepted(later, 'C', 'C')
    const working = rig.send('W')
    expect(await working.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(working.id))?.handedOverAt).toBeDefined()
    )
    const queued = await rig.send('Q', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    await rig.restartHostProcess()
    const waiting = [{ messageId: queued.value.queued.messageId, state: 'waiting' }]
    expect(await rig.drafts()).toEqual(waiting)
    // Sent before the restart, so its turn ends nothing the restart paused.
    await accepted(working.id, 'W', 'W')
    expect(
      journal()
        .queuedMessages.pauses()
        .map(({ reason }) => reason)
    ).toEqual(['restarted'])

    await rewindTo(later)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(await rig.drafts()).toEqual(waiting)
    expect(
      journal()
        .queuedMessages.pauses()
        .map(({ reason }) => reason)
    ).toEqual(['restarted'])
    expect(dispatched()).toEqual(['B <- [A]', 'C', 'W'])
  })

  it('a stopped message nothing carried survives the rewind and stays owed', async () => {
    await begin()
    const stopped = await stopWhileStarting('A')
    // Another agent's mail never carries a person's stopped messages.
    const mail = await nextSend('mail', true)
    await accepted(mail, 'mail', 'mail')
    const later = await nextSend('more mail', true)
    await accepted(later, 'more', 'more mail')

    await rewindTo(later)

    await expectStillStopped(stopped)
    await nextSend('C')
    expect(dispatched()).toEqual(['mail', 'more mail', 'C <- [A]'])
  })
})

describe('a rewind that stopped after its history committed', () => {
  it('settles on reopen with the carrier restated, never replacing the history twice', async () => {
    await start()
    const { stopped, carrier } = await stoppedThenCarried()
    const later = await nextSend('C')
    await accepted(later, 'C', 'C')
    const replace = journal().replaceEpochItems.bind(journal())
    vi.spyOn(journal(), 'replaceEpochItems').mockImplementationOnce(async (...args) => {
      await replace(...args)
      throw new Error('crashed after the commit')
    })

    await expect(
      rig.host.rewind(QUEUED_RIG_CALLER, {
        itemId: agentJournalSubmissionKey(later),
        expectedEpoch: journal().cursor().epoch,
        envelope: rig.envelope(
          { itemId: agentJournalSubmissionKey(later), expectedEpoch: journal().cursor().epoch },
          'agentSession.rewind',
          hostTestOperationId()
        )
      })
    ).rejects.toThrow('crashed after the commit')
    await rig.restartHostProcess()
    await nextSend('D')

    expect(rig.store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
    expect(journal().stoppedHistoryCarried().get(carrier)).toEqual([stopped])
    expect(dispatched()).toEqual(['B <- [A]', 'C', 'D'])
  })
})
