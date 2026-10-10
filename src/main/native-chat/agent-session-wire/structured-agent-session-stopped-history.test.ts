// A message a person sent and then stopped before the agent started on it reaches the agent with
// their next send, as framed context in that same write, exactly once. Against the real host,
// store and journal, with an agent that stays starting until the test proves its start.

import { afterEach, describe, expect, it } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionKind
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedRigProviderOptions } from './structured-agent-session-queued-message-rig-provider.test-fixture'
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

/** Each dispatch as `carrier <- [history]`. */
function dispatched(): string[] {
  return rig.dispatch.mock.calls.map(([input]) => {
    const history = (input.history ?? []).map(text)
    return history.length > 0 ? `${text(input.body)} <- [${history.join(', ')}]` : text(input.body)
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
        rejection: { kind: 'cancelled' }
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
  outcome: { kind: 'rejected'; fact: SubmissionRejectionKind; reached?: true } | { kind: 'unknown' }
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
            outcome.reached ? { mayHaveReachedAgent: true } : {}
          ),
          { surface: 'rejection' }
        )
      })
}

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

describe('stopped messages ride with the next send', () => {
  it('carries both messages a Stop withdrew while the agent started, in order, on the handover row', async () => {
    await start()
    const [first, second] = await stopWhileStarting('first', 'second')

    const next = await nextSend('what did I send?')

    expect(dispatched()).toEqual(['what did I send? <- [first, second]'])
    expect(journal().stoppedHistoryCarried().get(next)).toEqual([first, second])
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

  it('a carrier refused before any write leaves them owed: the next send carries them again', async () => {
    await start()
    const [first, second] = await stopWhileStarting('first', 'second')
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' })
    })
    await nextSend('refused')
    const next = await nextSend('again')

    expect(dispatched()).toEqual(['refused <- [first, second]', 'again <- [first, second]'])
    expect(journal().stoppedHistoryCarried().get(next)).toEqual([first, second])
  })

  it('a carrier the agent accepted delivered them: the next send carries nothing', async () => {
    await start()
    await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    await rig.settleAccepted(carrier, 'carrier')
    await nextSend('after')

    expect(dispatched()).toEqual(['carrier <- [first]', 'after'])
  })

  it('a carrier in doubt is never re-sent, nor what it carried', async () => {
    await start()
    await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    await settle(carrier, { kind: 'unknown' })
    await nextSend('after')

    expect(dispatched()).toEqual(['carrier <- [first]', 'after'])
  })

  it('a retry of the same send replays its answer and carries nothing again', async () => {
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
    expect(dispatched()).toEqual(['carrier <- [first]'])
  })

  it('two Stops in a row, the second while the next send waited on the start, flatten in send order', async () => {
    await start()
    await stopWhileStarting('first')
    // Stopped during its own start: nothing was written, so it is owed with what it would carry.
    await stopWhileStarting('second')
    expect(rig.dispatch).not.toHaveBeenCalled()
    await nextSend('third')

    expect(dispatched()).toEqual(['third <- [first, second]'])
  })

  it('a carrier a Stop withdrew unwritten is owed with what it carried, flattened', async () => {
    await start()
    const [first] = await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    // As Claude reports a queued frame its Stop swept before it started.
    await settle(carrier, { kind: 'rejected', fact: 'cancelled' })
    const next = await nextSend('next')

    expect(dispatched()).toEqual(['carrier <- [first]', 'next <- [first, carrier]'])
    expect(journal().stoppedHistoryCarried().get(next)).toEqual([first, carrier])
  })

  it('never carries a send Codex may have recorded when its Stop withdrew it', async () => {
    await start()
    const sent = await nextSend('sent')
    await settle(sent, { kind: 'rejected', fact: 'cancelled', reached: true })
    await nextSend('next')

    expect(dispatched()).toEqual(['sent', 'next'])
  })

  it('a host restart with a carrier still pending recovers it as doubt and re-sends nothing', async () => {
    await start()
    await stopWhileStarting('first')
    const carrier = await nextSend('carrier')
    await rig.restartHostProcess()
    await nextSend('after restart')

    expect(await rig.submission(carrier)).toMatchObject({ dispatchState: 'unknown' })
    expect(dispatched()).toEqual(['carrier <- [first]', 'after restart'])
  })

  it('two sends at once, from a phone and a desktop: the first handed over carries them, once', async () => {
    await start()
    await stopWhileStarting('first')
    const phone = rig.send('from the phone')
    const desktop = rig.send('from the desktop')
    expect(await phone.result).toMatchObject({ ok: true })
    expect(await desktop.result).toMatchObject({ ok: true })
    await rig.proveStart()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
    await rig.settleAccepted(phone.id, 'phone')
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))

    expect(dispatched()).toEqual(['from the phone <- [first]', 'from the desktop'])
  })

  it('mail and slash commands never carry, and stopped mail is never carried', async () => {
    await start()
    const ids = await heldWhileStarting('first')
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
    const next = await nextSend('next')

    expect(dispatched()).toEqual(['more mail', '/review', 'next <- [first]'])
    expect(journal().stoppedHistoryCarried().get(next)).toEqual(ids)
  })

  it('history that would not fit goes later: the send goes alone and they stay owed', async () => {
    let fits = false
    await start({ historyFits: async () => fits })
    const [first] = await stopWhileStarting('first')
    const alone = await nextSend('alone')
    expect(journal().stoppedHistoryCarried().has(alone)).toBe(false)
    await rig.settleAccepted(alone, 'alone')
    fits = true
    const next = await nextSend('next')

    expect(dispatched()).toEqual(['alone', 'next <- [first]'])
    expect(journal().stoppedHistoryCarried().get(next)).toEqual([first])
  })

  it('carrying them changes no work outcome: the chat is idle and each still reads Stopped manually once', async () => {
    await start()
    await stopWhileStarting('first')
    expect(working()).toBe(false)
    const carrier = await nextSend('carrier')
    await rig.settleAccepted(carrier, 'carrier')

    expect(working()).toBe(false)
    expect(await rig.submission(carrier)).toMatchObject({ dispatchState: 'accepted' })
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
})
