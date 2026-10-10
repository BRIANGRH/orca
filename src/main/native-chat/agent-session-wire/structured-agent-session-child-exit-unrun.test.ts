// What a child that ended while starting was handed and never echoed is settled as: a person's
// Stop withdraws it with proof it never reached the agent; any other close proves nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import {
  endExitedStructuredAgentSessionChildUnderSerialize,
  type StructuredAgentSessionChildExitContext,
  type StructuredAgentSessionChildExitSession
} from './structured-agent-session-child-exit'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'

vi.mock('./structured-agent-session-dead-generation-settlement', () => ({
  settleStructuredAgentSessionDeadGeneration: vi.fn(async () => ({ ok: true }))
}))
vi.mock('./structured-agent-session-lease-release', () => ({
  releaseStoredStructuredAgentSessionOwnerAfterExit: vi.fn(async () => undefined)
}))
vi.mock('./structured-agent-session-unfinished-work', () => ({
  captureUnfinishedStructuredAgentSessionWork: () => ({ hadUnsettledSubmissions: true }),
  unfinishedStructuredAgentSessionWorkWasInterrupted: () => false
}))
vi.mock('./structured-agent-session-send-preparation', () => ({
  structuredAgentSessionFailureWordsContext: () => ({})
}))
vi.mock('./structured-agent-session-provider-child', () => ({ endProviderChild: vi.fn() }))

const SESSION = 'session-1'

async function endStartingChild(cause: 'user-stop' | 'host-stop' | 'user-close'): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only a starting child's phase, fence, generation and close.
  const child = {
    phase: 'starting',
    fence: 1,
    generation: 'generation-1',
    close: { cause, reason: null, requestedAt: 1 }
  } as unknown as StructuredAgentSessionProviderChild
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settlement is mocked, so the journal is never read.
  const session = {
    child,
    lastEndedChild: null,
    journal: {}
  } as unknown as StructuredAgentSessionChildExitSession
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the members the handler calls are given.
  const context = {
    store: { getRecord: () => ({ lease: { handoffStage: null } }) },
    sessions: new Map([[SESSION, session]]),
    flushLifecycle: async () => ({ ok: true }),
    publishFence: () => undefined,
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    now: () => 2,
    logger: { warn: vi.fn(), error: vi.fn() }
  } as unknown as StructuredAgentSessionChildExitContext<StructuredAgentSessionChildExitSession>
  await endExitedStructuredAgentSessionChildUnderSerialize(context, SESSION, child, {
    expected: true,
    reason: 'closed'
  })
  const settle = vi.mocked(settleStructuredAgentSessionDeadGeneration)
  return settle.mock.calls.at(-1)?.[0].unrunRejection
}

describe('a child that ended while starting', () => {
  beforeEach(() => {
    vi.mocked(settleStructuredAgentSessionDeadGeneration).mockClear()
  })

  it("under a person's Stop: withdrawn, with proof it never reached the agent", async () => {
    expect(await endStartingChild('user-stop')).toEqual({
      kind: 'cancelled',
      neverReachedAgent: true
    })
  })

  it('under any other close: no such proof', async () => {
    expect(await endStartingChild('host-stop')).toBeUndefined()
    expect(await endStartingChild('user-close')).toBeUndefined()
  })
})
