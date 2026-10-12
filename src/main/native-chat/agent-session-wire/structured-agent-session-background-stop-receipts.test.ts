// A background-task Stop is saved before it asks the agent, yet one the agent refuses or cannot
// confirm still reports "not done" on its first answer. A retry of its id is answered from the
// receipt and never asks the agent again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const
const FIELDS = { turnId: 'background-tasks', scope: 'background-tasks' }

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

async function backgroundStopWith(
  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>
) {
  rig.host.deps.statusSink = { publish: () => {}, forget: () => {}, readChildWork: () => [TASK] }
  await rig.workingSend()
  const provider = vi.fn(stopBackgroundTasks)
  Object.assign(rig.host.deps.adapter, { stopBackgroundTasks: provider })
  const id = opId()
  const stop = () =>
    rig.host.cancel(CALLER, {
      envelope: rig.envelope(FIELDS, 'agentSession.cancel', id),
      turnId: 'background-tasks',
      scope: 'background-tasks' as const
    })
  return { provider, stop, receipt: () => rig.store.readCommandReceipt(CALLER_SCOPE, id) }
}

describe('a background-task Stop the agent will not stop', () => {
  it('says the task still runs on its first answer; a retry answers from its receipt', async () => {
    const { provider, stop, receipt } = await backgroundStopWith(async () => ({
      cancelled: false,
      stillRunning: true
    }))

    expect(await stop()).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(receipt()).toMatchObject({ verdict: 'readable', receipt: { result: { kind: 'stop' } } })
    expect(await stop()).toMatchObject({
      ok: true,
      replayed: true,
      value: { turnId: 'background-tasks', cancelled: false }
    })
    expect(provider).toHaveBeenCalledOnce()
  })

  it.each([
    ['timed out', 'codex app-server request timed out'],
    ['lost the agent', 'codex app-server connection closed']
  ])('answers one that %s as unconfirmed, then from its receipt', async (_, message) => {
    const { provider, stop, receipt } = await backgroundStopWith(async () => {
      throw new Error(message)
    })

    expect(await stop()).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(receipt()).toMatchObject({ verdict: 'readable', receipt: { result: { kind: 'stop' } } })
    expect(await stop()).toMatchObject({
      ok: true,
      replayed: true,
      value: { turnId: 'background-tasks', cancelled: false }
    })
    expect(provider).toHaveBeenCalledOnce()
  })
})
