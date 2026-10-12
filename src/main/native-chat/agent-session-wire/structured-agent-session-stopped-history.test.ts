// A message a person sent and then stopped before the agent started on it goes into the agent's own
// log at their next send, ahead of it, at most once; an agent that cannot append carries it in that
// send instead. Against the real host, store and journal, with an agent that stays starting until
// the test proves its start.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionKind
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OwedStoppedMessage } from '../../../shared/agent-session-stopped-history'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  RigPreparedDispatch,
  type QueuedRigProviderOptions
} from './structured-agent-session-queued-message-rig-provider.test-fixture'
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

async function start(options: QueuedRigProviderOptions = {}): Promise<void> {
  rig = await createQueuedMessageTestRig({ restartable: true, starting: true, ...options })
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

/** Each append, as the texts of the stopped messages it wrote. */
function appended(): string[][] {
  return rig.appendStoppedMessages.mock.calls.map(([input]) =>
    input.messages.map((entry) => text(entry.body))
  )
}

/** Each dispatch as `carrier <- [history]`, the history as the prepared send carries it. */
function dispatched(): string[] {
  return rig.dispatch.mock.calls.map(([input]) => {
    const prepared = input.prepared instanceof RigPreparedDispatch ? input.prepared : null
    expect(input.prepared === undefined || prepared !== null).toBe(true)
    return prepared ? `${text(input.body)} <- [${prepared.history.join(', ')}]` : text(input.body)
  })
}

function sendRequest(body: string) {
  const message = hostTestMessage(body)
  return {
    envelope: rig.envelope({ body: message }, 'agentSession.send', hostTestOperationId()),
    body: message,
    userSend: true as const
  }
}

/** Sent while the agent starts, so the host holds them; none is handed over. */
async function heldWhileStarting(...texts: string[]): Promise<string[]> {
  if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child) {
    await rig.host.close(SESSION, 'evict')
  }
  const ids: string[] = []
  for (const body of texts) {
    const request = sendRequest(body)
    expect(await rig.host.send(QUEUED_RIG_CALLER, request)).toMatchObject({ ok: true })
    ids.push(request.envelope.clientOperationId)
  }
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  return ids
}

/** A Stop while the agent starts: what it held is withdrawn, never written. */
async function stopWhileStarting(...texts: string[]): Promise<string[]> {
  const ids = await heldWhileStarting(...texts)
  expect(await rig.stop()).toMatchObject({ ok: true })
  for (const id of ids) {
    await eventually(async () =>
      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        // Host-held: the Stop's withdrawal proves it never reached the agent.
        rejection: { kind: 'cancelled', neverReachedAgent: true }
      })
    )
  }
  return ids
}

/** The person's next send, handed to a child that proved its start. */
async function nextSend(body: string, options: Parameters<QueuedMessageTestRig['send']>[2] = {}) {
  const before = rig.dispatch.mock.calls.length
  const { id, result } = rig.send(body, undefined, options)
  expect(await result).toMatchObject({ ok: true })
  if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase !== 'ready') {
    await rig.proveStart()
  }
  await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(before + 1))
  return id
}

/** How a provider settles a handed-over send, as `settleLateDispatch` takes it. */
function settle(
  id: string,
  outcome:
    | { kind: 'rejected'; fact: SubmissionRejectionKind; neverReached?: true }
    | { kind: 'unknown' }
): Promise<void> {
  return outcome.kind === 'unknown'
    ? rig.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: id,
        state: 'unknown',
        reason: 'reply lost'
      })
    : rig.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: id,
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact(
            outcome.fact,
            outcome.neverReached ? { neverReachedAgent: true } : {}
          ),
          { surface: 'rejection' }
        )
      })
}

/** A second client, attached as the phone is. */
const PHONE_CALLER = { callerKey: 'phone-1' }

const MAIL = {
  kind: 'agent' as const,
  senders: [],
  orchestration: null
}

/** The chat's Working, as every session list reads it. */
function working(): boolean {
  return isStructuredAgentSessionMainAgentWorking(journal().activeTurnId(), journal().submissions())
}

/** The texts a client draws: desktop (`rejectedInPlace`) or phone. */
async function transcript(rejectedInPlace: boolean): Promise<string[]> {
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return projectStructuredAgentSessionMessages(page.page.items, [], page.page.submissions, {
    rejectedInPlace
  }).map(
    (message) =>
      `${message.blocks.map((block) => ('text' in block ? block.text : '')).join('')}${
        message.stoppedBeforeStart ? ' (stopped)' : ''
      }`
  )
}

describe("stopped messages go into the agent's own log ahead of the next send", () => {
  it('appends both messages a Stop withdrew while the agent started, in order, before the send', async () => {
    await start()
    const [first, second] = await stopWhileStarting('first', 'second')

    await nextSend('what did I send?')

    expect(appended()).toEqual([['first', 'second']])
    expect(dispatched()).toEqual(['what did I send?'])
    expect(rig.appendStoppedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      rig.dispatch.mock.invocationCallOrder[0]!
    )
    expect(
      [...journal().stoppedHistory.appended().values()].map((append) => append.messageIds)
    ).toEqual([[first, second]])
    // The work outcome is untouched: each stopped message still reads Stopped manually, once.
    for (const id of [first!, second!]) {
      expect(await rig.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
      })
    }
    for (const rejectedInPlace of [true, false]) {
      expect(await transcript(rejectedInPlace)).toEqual([
        'first (stopped)',
        'second (stopped)',
        'Stopped manually',
        'what did I send?'
      ])
    }
  })

  it('appends nothing again once the agent took them', async () => {
    await start()
    await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    await rig.settleAccepted(carrier, 'carrier')
    await nextSend('after')

    expect(appended()).toEqual([['first']])
    expect(dispatched()).toEqual(['carrier', 'after'])
  })

  it('appends them again at the next send when the agent proved it refused them', async () => {
    await start()
    await stopWhileStarting('first')
    // As a Codex without `thread/inject_items` answers.
    rig.appendStoppedMessages.mockResolvedValueOnce({ outcome: 'refused', reason: '-32601' })
    const carrier = await nextSend('carrier')
    await rig.settleAccepted(carrier, 'carrier')
    await nextSend('after')

    expect(appended()).toEqual([['first'], ['first']])
    expect(dispatched()).toEqual(['carrier', 'after'])
    expect(journal().stoppedHistory.appended().size).toBe(1)
  })

  it('writes no row while the agent answers it cannot take them, and appends them once it can', async () => {
    await start()
    await stopWhileStarting('first')
    // As Codex mid-turn or Claude woken by a background task answers.
    rig.stoppedMessageDelivery.mockReturnValueOnce('none')
    const recordAppend = vi.spyOn(journal().stoppedHistory, 'recordAppend')
    const busy = await nextSend('busy')
    await rig.settleAccepted(busy, 'busy')

    expect(recordAppend).not.toHaveBeenCalled()
    expect(appended()).toEqual([])
    await nextSend('after')
    expect(appended()).toEqual([['first']])
    expect(recordAppend).toHaveBeenCalledTimes(1)
    expect(dispatched()).toEqual(['busy', 'after'])
  })

  it('never appends them again when the outcome is unknown, or the append threw', async () => {
    for (const fails of [
      () =>
        rig.appendStoppedMessages.mockResolvedValueOnce({
          outcome: 'unknown',
          reason: 'timed out'
        }),
      () => rig.appendStoppedMessages.mockRejectedValueOnce(new Error('lost contact'))
    ]) {
      await start()
      await stopWhileStarting('first')
      fails()
      const carrier = await nextSend('carrier')
      await rig.settleAccepted(carrier, 'carrier')
      await nextSend('after')

      // The send goes on whatever came of the append.
      expect(appended()).toEqual([['first']])
      expect(dispatched()).toEqual(['carrier', 'after'])
      await rig.dispose()
    }
    await start()
  })

  it('a record written before a crash covers them across the restart', async () => {
    await start()
    const [first] = await stopWhileStarting('first')
    // The host died after the record and before the write's answer.
    await journal().stoppedHistory.recordAppend(
      { appendId: 'crashed', messageIds: [first!] },
      rig.store.getRecord(SESSION)!.lease.runtimeFence
    )
    await rig.restartHostProcess()
    await nextSend('after restart')

    expect(appended()).toEqual([])
    expect(dispatched()).toEqual(['after restart'])
  })

  it('a refusal survives a restart: what it refused is still owed', async () => {
    await start()
    await stopWhileStarting('first')
    rig.appendStoppedMessages.mockResolvedValueOnce({ outcome: 'refused', reason: 'Codex busy' })
    const carrier = await nextSend('carrier')
    await rig.settleAccepted(carrier, 'carrier')
    await rig.restartHostProcess()
    await nextSend('after restart')

    expect(appended()).toEqual([['first'], ['first']])
  })

  it('a retry of the same send replays its answer and appends nothing again', async () => {
    await start()
    await stopWhileStarting('first')
    const request = sendRequest('carrier')
    expect(await rig.host.send(QUEUED_RIG_CALLER, request)).toMatchObject({ ok: true })
    await rig.proveStart()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))

    expect(await rig.host.send(QUEUED_RIG_CALLER, request)).toMatchObject({
      ok: true,
      value: { clientMessageId: request.envelope.clientOperationId }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(appended()).toEqual([['first']])
    expect(dispatched()).toEqual(['carrier'])
  })

  it('two Stops in a row, the second while the next send waited on the start, append in send order', async () => {
    await start()
    await stopWhileStarting('first')
    // Stopped during its own start: nothing was written, so it is owed too.
    await stopWhileStarting('second')
    expect(rig.dispatch).not.toHaveBeenCalled()
    await nextSend('third')

    expect(appended()).toEqual([['first', 'second']])
    expect(dispatched()).toEqual(['third'])
  })

  it('never appends a withdrawal no one proved unwritten, as Codex writes and old journals hold', async () => {
    await start()
    const sent = await nextSend('sent')
    await settle(sent, { kind: 'rejected', fact: 'cancelled' })
    await nextSend('next')

    expect(appended()).toEqual([])
  })

  it('two sends at once, from a phone and a desktop: the first handed over appends them, once', async () => {
    await start()
    await stopWhileStarting('first')
    const phoneRequest = sendRequest('from the phone')
    const desktopRequest = sendRequest('from the desktop')
    const [phone, desktop] = await Promise.all([
      rig.host.send(PHONE_CALLER, phoneRequest),
      rig.host.send(QUEUED_RIG_CALLER, desktopRequest)
    ])
    expect(phone).toMatchObject({ ok: true })
    expect(desktop).toMatchObject({ ok: true })
    await rig.proveStart()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    await rig.settleAccepted(phoneRequest.envelope.clientOperationId, 'phone')
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))

    expect(appended()).toEqual([['first']])
    expect(dispatched()).toEqual(['from the phone', 'from the desktop'])
  })

  it('mail and slash commands append nothing, and stopped mail is never appended', async () => {
    await start()
    await heldWhileStarting('first')
    const mail = rig.send('mail', undefined, { internal: true, from: MAIL })
    expect(await mail.result).toMatchObject({ ok: true })
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(await rig.submission(mail.id)).toMatchObject({ dispatchState: 'rejected' })
    )
    await nextSend('more mail', { internal: true, from: MAIL })
    await rig.settleAccepted(rig.dispatch.mock.calls.at(-1)![0].clientMessageId, 'mail')
    await nextSend('/review')
    await rig.settleAccepted(rig.dispatch.mock.calls.at(-1)![0].clientMessageId, 'review')
    await nextSend('next')

    expect(appended()).toEqual([['first']])
    expect(dispatched()).toEqual(['more mail', '/review', 'next'])
  })

  it('appending them changes no work outcome: the chat is idle and each still reads Stopped manually once', async () => {
    await start()
    await stopWhileStarting('first')
    expect(working()).toBe(false)
    const carrier = await nextSend('carrier')
    await rig.settleAccepted(carrier, 'carrier')

    expect(working()).toBe(false)
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.submissions.some((entry) => 'carries' in entry)).toBe(false)
    for (const rejectedInPlace of [true, false]) {
      expect(await transcript(rejectedInPlace)).toEqual([
        'first (stopped)',
        'Stopped manually',
        'carrier'
      ])
    }
  })

  it('a real /clear bounds what is owed: what was stopped before it is never appended', async () => {
    await start()
    await stopWhileStarting('before clear')
    const fields = { command: 'clear' as const }
    expect(
      await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    await stopWhileStarting('after clear')
    await nextSend('next')

    expect(appended()).toEqual([['after clear']])
  })
})

describe('an agent that cannot append carries them in the next send', () => {
  const carrying = (options: QueuedRigProviderOptions = {}) =>
    start({ carriesStoppedHistory: true, ...options })

  it('carries both, in order, named on the handover row', async () => {
    await carrying()
    const [first, second] = await stopWhileStarting('first', 'second')
    const next = await nextSend('what did I send?')

    expect(dispatched()).toEqual(['what did I send? <- [first, second]'])
    expect(journal().stoppedHistory.carried().get(next)).toEqual([first, second])
    expect(appended()).toEqual([])
  })

  it('a carrier refused before any write leaves them owed: the next send carries them again', async () => {
    await carrying()
    await stopWhileStarting('first', 'second')
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' })
    })
    await nextSend('refused')
    await nextSend('again')

    expect(dispatched()).toEqual(['refused <- [first, second]', 'again <- [first, second]'])
  })

  it('a carrier in doubt is never re-sent, nor what it carried', async () => {
    await carrying()
    await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    await settle(carrier, { kind: 'unknown' })
    await nextSend('after')

    expect(dispatched()).toEqual(['carrier <- [first]', 'after'])
  })

  it('a carrier Pi refused at its sign-in check leaves them owed', async () => {
    await carrying()
    await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    await settle(carrier, { kind: 'rejected', fact: 'notSignedIn', neverReached: true })
    // A child that said it is signed out is replaced before the next send.
    const { result } = rig.send('next')
    expect(await result).toMatchObject({ ok: true })
    await eventually(() =>
      expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
    )
    await rig.proveStart()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))

    expect(dispatched()).toEqual(['carrier <- [first]', 'next <- [first]'])
  })

  it('the row lists exactly what the prepared send carries, and the rest stays owed', async () => {
    // Room for the oldest only, as an agent near its limit prepares it.
    await carrying({
      prepareDispatch: async ({ owed }) =>
        new RigPreparedDispatch([owed[0]!.submission.clientMessageId], [text(owed[0]!.body)])
    })
    const [first, second] = await stopWhileStarting('first', 'second')
    const carrier = await nextSend('carrier')

    expect(journal().stoppedHistory.carried().get(carrier)).toEqual([first])
    await rig.settleAccepted(carrier, 'carrier')
    const next = await nextSend('next')

    expect(dispatched()).toEqual(['carrier <- [first]', 'next <- [second]'])
    expect(journal().stoppedHistory.carried().get(next)).toEqual([second])
  })

  it('a preparation that throws sends the message alone and leaves them owed', async () => {
    let fails = true
    await carrying({
      prepareDispatch: async ({ owed }) => {
        if (fails) {
          throw new Error('image read failed')
        }
        return new RigPreparedDispatch(
          owed.map((entry) => entry.submission.clientMessageId),
          owed.map((entry) => text(entry.body))
        )
      }
    })
    await stopWhileStarting('first')
    const alone = await nextSend('alone')
    await rig.settleAccepted(alone, 'alone')
    fails = false
    await nextSend('next')

    expect(dispatched()).toEqual(['alone', 'next <- [first]'])
  })

  it('a preparation that stalls sends the message alone after its limit, and holds Stop no longer', async () => {
    let stalls = true
    const prepareDispatch = vi.fn(async ({ owed }: { owed: readonly OwedStoppedMessage[] }) =>
      stalls
        ? new Promise<null>(() => {})
        : new RigPreparedDispatch(
            owed.map((entry) => entry.submission.clientMessageId),
            owed.map((entry) => text(entry.body))
          )
    )
    await carrying({ prepareDispatch })
    await stopWhileStarting('first')
    const { id: alone, result } = rig.send('alone')
    expect(await result).toMatchObject({ ok: true })
    await rig.proveStart()
    await eventually(() => expect(prepareDispatch).toHaveBeenCalledTimes(1))
    // Pressed while the stalled preparation holds the lane.
    const pressedAt = Date.now()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(Date.now() - pressedAt).toBeLessThan(5_000)
    await rig.settleAccepted(alone, 'alone')
    stalls = false
    await nextSend('next')

    expect(dispatched()).toEqual(['alone', 'next <- [first]'])
  })
})
