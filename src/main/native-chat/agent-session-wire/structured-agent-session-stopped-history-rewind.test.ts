// A Codex rewind keeps a person's stopped messages before the rewind point: each keeps its bubble and
// the record of its append, as Codex keeps the appended pair that sits just before the next turn, so
// it is never appended twice. One after the point goes, as Codex drops its pair. Against the real
// host, store and journal, with a Codex-shaped rewind that answers with the items its thread holds.

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

/** Each send, with the stopped messages appended to the agent's log ahead of it. */
function dispatched(): string[] {
  const appends = rig.appendStoppedMessages.mock.calls.map(([input], index) => ({
    at: rig.appendStoppedMessages.mock.invocationCallOrder[index]!,
    texts: input.messages.map((entry) => text(entry.body))
  }))
  let previous = 0
  return rig.dispatch.mock.calls.map(([input], index) => {
    const at = rig.dispatch.mock.invocationCallOrder[index]!
    const ahead = appends.filter((append) => append.at > previous && append.at < at)
    previous = at
    const history = ahead.flatMap((append) => append.texts)
    return history.length > 0 ? `[${history.join(', ')}] -> ${text(input.body)}` : text(input.body)
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

/** To before the turn `id` opened, or the row `itemId` names. */
async function rewindTo(id: string, itemId = agentJournalSubmissionKey(id)): Promise<void> {
  const fields = { itemId, expectedEpoch: journal().cursor().epoch }
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

/** Stop A, then B's handover appends it and the agent takes B. */
async function stoppedThenAppended(): Promise<{ stopped: string; next: string }> {
  const stopped = await stopWhileStarting('A')
  const next = await nextSend('B')
  await accepted(next, 'B', 'B')
  return { stopped, next }
}

function appendedIds(): string[] {
  return [...journal().stoppedHistory.appended().values()].flatMap((append) => append.messageIds)
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

  it('rewound before the send that appended it: the bubble and its record stay', async () => {
    await begin()
    const { stopped, next } = await stoppedThenAppended()
    const epoch = journal().cursor().epoch

    await rewindTo(next)

    expectRebuildPath(epoch)
    expect(await transcripts()).toEqual(shown('A (stopped)', 'Stopped manually'))
    await expectStillStopped(stopped)
    expect(appendedIds()).toEqual([stopped])
    await nextSend('C')
    expect(dispatched()).toEqual(['[A] -> B', 'C'])
  })

  it('rewound after it: the bubble and its record stay', async () => {
    await begin()
    const { stopped } = await stoppedThenAppended()
    const later = await nextSend('C')
    await accepted(later, 'C', 'C')
    const epoch = journal().cursor().epoch

    await rewindTo(later)

    expectRebuildPath(epoch)
    expect(await transcripts()).toEqual(shown('A (stopped)', 'Stopped manually', 'B'))
    await expectStillStopped(stopped)
    expect(appendedIds()).toEqual([stopped])
    await nextSend('D')
    expect(dispatched()).toEqual(['[A] -> B', 'C', 'D'])
  })

  it('rewound to a turn between the Stop and the append: the record goes, as Codex drops the pair', async () => {
    await begin()
    const stopped = await stopWhileStarting('A')
    // Another agent's mail opens a turn and appends nothing; the next send appends A after it.
    const mail = await nextSend('M', true)
    await accepted(mail, 'M', 'M')
    const next = await nextSend('C')
    await accepted(next, 'C', 'C')
    expect(appendedIds()).toEqual([stopped])

    await rewindTo(mail)

    expect(await transcripts()).toEqual(shown('A (stopped)', 'Stopped manually'))
    await expectStillStopped(stopped)
    expect(appendedIds()).toEqual([])
    await nextSend('D')
    expect(dispatched()).toEqual(['M', '[A] -> C', '[A] -> D'])
  })

  it('a second rewind reads the kept record where it sat, not after the rows rebuilt with it', async () => {
    await begin()
    const { stopped, next } = await stoppedThenAppended()
    const later = await nextSend('C')
    await accepted(later, 'C', 'C')
    const nextItem = (await rig.submission(next))?.providerItemId ?? undefined
    await rewindTo(later)

    // Codex still holds the pair, injected before B.
    await rewindTo(next, nextItem)

    expect(appendedIds()).toEqual([stopped])
    await nextSend('D')
    expect(dispatched()).toEqual(['[A] -> B', 'C', 'D'])
  })

  it('one still owed stays owed through the rewind', async () => {
    await begin()
    const stopped = await stopWhileStarting('A')
    // A Codex without `thread/inject_items` refuses each append.
    rig.appendStoppedMessages.mockResolvedValue({ outcome: 'refused', reason: '-32601' })
    const next = await nextSend('B')
    await accepted(next, 'B', 'B')
    const later = await nextSend('C')
    await accepted(later, 'C', 'C')

    await rewindTo(later)

    await expectStillStopped(stopped)
    expect(appendedIds()).toEqual([])
    await nextSend('D')
    expect(dispatched()).toEqual(['[A] -> B', '[A] -> C', '[A] -> D'])
  })

  it('one stopped after the rewind point goes, as Codex drops its pair', async () => {
    await begin()
    const first = await nextSend('B')
    await accepted(first, 'B', 'B')
    await stopWhileStarting('A')
    const next = await nextSend('C')
    await accepted(next, 'C', 'C')

    await rewindTo(first)

    expect(await transcripts()).toEqual(shown())
    await nextSend('D')
    expect(dispatched()).toEqual(['B', '[A] -> C', 'D'])
  })

  it('a host restart after a rewind keeps the record: nothing is appended twice', async () => {
    await begin()
    const { stopped, next } = await stoppedThenAppended()
    await rewindTo(next)
    await rig.restartHostProcess()
    await nextSend('C')

    expect(appendedIds()).toEqual([stopped])
    expect(dispatched()).toEqual(['[A] -> B', 'C'])
  })
})
