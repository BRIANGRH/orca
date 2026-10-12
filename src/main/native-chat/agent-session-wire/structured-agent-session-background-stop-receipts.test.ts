// A background-task Stop is saved before it asks the agent, and its answer is that acceptance. A
// task the agent will not stop, or a stop it cannot confirm, says so in a note keyed by the Stop's
// own id; a retry of that id is answered from the receipt and neither asks again nor notes again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const

const TASK: AgentChildWorkView = {
  id: 'child-task-1',
  providerId: 'task-1',
  kind: 'agent',
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 1,
  stoppable: true,
  invocation: { invocationId: 'spawn-task-1', generation: 1 }
}

let rig: QueuedMessageTestRig
let serial = 0

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function opId(): string {
  serial += 1
  return `${NOW}-${serial.toString(16).padStart(32, 'e')}`
}

/** Every status row's words and fact, in journal order. */
async function statusNotes(): Promise<{ text: string; failure?: unknown }[]> {
  const items = (await rig.host.journalSnapshot(SESSION)).items
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure
      ? [{ text: item.body.text, failure: item.body.failure }]
      : []
  )
}

async function backgroundStopWith(
  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>,
  taskId?: string
) {
  rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork: () => [TASK] }
  await rig.workingSend()
  const provider = vi.fn(stopBackgroundTasks)
  Object.assign(rig.host.deps.adapter, { stopBackgroundTasks: provider })
  const id = opId()
  const fields = {
    turnId: 'background-tasks',
    scope: 'background-tasks',
    ...(taskId ? { taskId } : {})
  }
  const stop = () =>
    rig.host.cancel(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.cancel', id),
      turnId: 'background-tasks',
      scope: 'background-tasks' as const,
      ...(taskId ? { taskId } : {})
    })
  return { provider, stop, receipt: () => rig.store.readCommandReceipt(CALLER_SCOPE, id) }
}

describe('a background-task Stop', () => {
  it('answers true once the agent stops the task, and writes no note', async () => {
    const { stop, receipt } = await backgroundStopWith(async () => ({ cancelled: true }))

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(receipt()).toMatchObject({ verdict: 'readable', receipt: { result: { kind: 'stop' } } })
    expect(await statusNotes()).toEqual([])
  })

  it.each([
    ['one named task', 'task-1', "The background task wasn't stopped."],
    ['every task', undefined, "The background tasks weren't stopped."]
  ])(
    'notes that %s still runs; a retry neither asks again nor notes again',
    async (_, taskId, words) => {
      const { provider, stop, receipt } = await backgroundStopWith(
        async () => ({ cancelled: false, stillRunning: true }),
        taskId
      )

      expect(await stop()).toMatchObject({
        ok: true,
        value: { turnId: 'background-tasks', cancelled: false }
      })
      expect(receipt()).toMatchObject({
        verdict: 'readable',
        receipt: { result: { kind: 'stop' } }
      })
      expect(await statusNotes()).toEqual([
        {
          text: words,
          failure: agentSessionFailureFact('backgroundTaskNotStopped', {
            backgroundStop: taskId ? 'task' : 'all'
          })
        }
      ])

      expect(await stop()).toMatchObject({
        ok: true,
        replayed: true,
        value: { turnId: 'background-tasks', cancelled: false }
      })
      expect(provider).toHaveBeenCalledOnce()
      expect(await statusNotes()).toHaveLength(1)
    }
  )

  it.each([
    ['timed out', 'codex app-server request timed out'],
    ['lost the agent', 'codex app-server connection closed']
  ])('notes one that %s as unconfirmed; a retry answers from its receipt', async (_, message) => {
    const { provider, stop } = await backgroundStopWith(async () => {
      throw new Error(message)
    })

    expect(await stop()).toMatchObject({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: false }
    })
    expect(await statusNotes()).toEqual([
      { text: 'Cancellation was not confirmed.', failure: { kind: 'cancelUnconfirmed' } }
    ])

    expect(await stop()).toMatchObject({
      ok: true,
      replayed: true,
      value: { turnId: 'background-tasks', cancelled: false }
    })
    expect(provider).toHaveBeenCalledOnce()
    expect(await statusNotes()).toHaveLength(1)
  })

  it('still answers from its saved acceptance when the note cannot be written', async () => {
    const { stop } = await backgroundStopWith(async () => ({
      cancelled: false,
      stillRunning: true
    }))
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    vi.spyOn(journal, 'appendItem').mockRejectedValueOnce(new Error('disk full'))

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await statusNotes()).toEqual([])
  })
})
