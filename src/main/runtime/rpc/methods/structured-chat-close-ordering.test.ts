import { expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createStructuredAgentSessionForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import {
  WORKTREE,
  acquisitions,
  call,
  caller,
  createChat,
  host,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createParams() {
  const params = {
    worktree: WORKTREE,
    agent: 'codex' as const,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    }
  }
  params.envelope.payloadFingerprint = structuredAgentSessionCreateIntentFingerprint(params)
  return params
}

async function closeChat() {
  return call('session.tabs.close', {
    worktree: WORKTREE,
    tabId: `agent-session:${HOST_TEST_SESSION}`,
    reason: 'user'
  })
}

it.each(['acquired', 'at-rest', 'in-process'] as const)(
  'cancels an earlier %s create still preparing, without poisoning the next create',
  async (mode) => {
    const reached = deferred()
    const release = deferred()
    const { envelope: _envelope, ...intent } = hostTestAttachParams(null)
    vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(async () => {
      reached.resolve()
      await release.promise
      return intent
    })
    const params = createParams()
    const creating =
      mode === 'in-process'
        ? createStructuredAgentSessionForWorktree({
            ...params,
            runtime,
            ensureHost: async () => host,
            caller,
            activate: true
          }).then((result) => result.ok)
        : call('agentSession.create', params, {
            clientKind: 'runtime',
            clientCapabilities: [
              STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
              ...(mode === 'at-rest' ? [AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY] : [])
            ]
          }).then((result) => result.result?.ok)
    await reached.promise
    try {
      expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
      expect(acquisitions).toBe(0)
    } finally {
      release.resolve()
    }
    expect(await creating).toBe(false)
    expect(acquisitions).toBe(0)
    expect(store.getRecord(HOST_TEST_SESSION)).toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([])

    expect(await call('agentSession.create', createParams())).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(acquisitions).toBe(1)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  }
)

it('cancels an at-rest create awaiting launch arguments before its opening message can start', async () => {
  const reached = deferred()
  const release = deferred()
  const { envelope: _envelope, ...intent } = hostTestAttachParams(null)
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockResolvedValue(intent)
  host.deps.resolveLaunchArgs = async () => {
    reached.resolve()
    await release.promise
    return undefined
  }
  const params = {
    ...createParams(),
    firstMessage: { clientMessageId: hostTestOperationId(), body: hostTestMessage('hello') }
  }
  params.envelope.payloadFingerprint = structuredAgentSessionCreateIntentFingerprint(params)
  const creating = call('agentSession.create', params)
  await reached.promise
  const hiding = deferred()
  const visibility = host.setSessionTabVisibility.bind(host)
  vi.spyOn(host, 'setSessionTabVisibility').mockImplementation(
    (...args: Parameters<typeof host.setSessionTabVisibility>) => {
      if (!args[1]) {
        hiding.resolve()
      }
      return visibility(...args)
    }
  )
  const closing = closeChat()
  // The close can queue behind founding, but its cancellation reaches that attempt immediately.
  await hiding.promise
  release.resolve()
  expect(await closing).toMatchObject({ ok: true, result: { closed: true } })
  expect(await creating).toMatchObject({ ok: true, result: { ok: false } })
  expect(acquisitions).toBe(0)
  expect(store.listVisibleSessionIds()).toEqual([])
  expect((await snapshot()).tabs).toEqual([])
})

it('does not publish an earlier reveal after a later close has finished', async () => {
  await createChat(HOST_TEST_SESSION)
  const reached = deferred()
  const release = deferred()
  const reveal = host.revealSession.bind(host)
  vi.spyOn(host, 'revealSession').mockImplementation(async (sessionId) => {
    const result = await reveal(sessionId)
    reached.resolve()
    await release.promise
    return result
  })
  const revealing = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
  await reached.promise
  try {
    expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
  } finally {
    release.resolve()
  }
  expect(await revealing).toMatchObject({
    ok: false,
    error: { code: 'agent_session_close_pending' }
  })
  expect(store.listVisibleSessionIds()).toEqual([])
  expect((await snapshot()).tabs).toEqual([])
  expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true,
    result: { ok: true }
  })
})

it('cancels an acquired create queued behind another host operation before acquisition begins', async () => {
  const reached = deferred()
  const release = deferred()
  const blocked = host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {
    reached.resolve()
    await release.promise
  })
  await reached.promise
  const { envelope: _envelope, ...intent } = hostTestAttachParams(null)
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockResolvedValue(intent)
  const enqueued = deferred()
  const attach = host.attach.bind(host)
  vi.spyOn(host, 'attach').mockImplementation((...args: Parameters<typeof host.attach>) => {
    const result = attach(...args)
    enqueued.resolve()
    return result
  })
  const hiding = deferred()
  const visibility = host.setSessionTabVisibility.bind(host)
  vi.spyOn(host, 'setSessionTabVisibility').mockImplementation(
    (...args: Parameters<typeof host.setSessionTabVisibility>) => {
      if (!args[1]) {
        hiding.resolve()
      }
      return visibility(...args)
    }
  )
  const creating = call('agentSession.create', createParams())
  await enqueued.promise
  const closing = closeChat()
  await hiding.promise
  release.resolve()
  await blocked
  expect(await closing).toMatchObject({ ok: true, result: { closed: true } })
  expect(await creating).toMatchObject({ ok: true, result: { ok: false } })
  expect(acquisitions).toBe(0)
  expect(store.getRecord(HOST_TEST_SESSION)).toBeNull()
})

it('does not project a reveal whose visibility write finished before the later close', async () => {
  await createChat(HOST_TEST_SESSION)
  const reached = deferred()
  const release = deferred()
  const visibility = host.setSessionTabVisibility.bind(host)
  vi.spyOn(host, 'setSessionTabVisibility').mockImplementation(
    async (...args: Parameters<typeof host.setSessionTabVisibility>) => {
      await visibility(...args)
      if (args[1]) {
        reached.resolve()
        await release.promise
      }
    }
  )
  const revealing = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
  await reached.promise
  try {
    expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
  } finally {
    release.resolve()
  }
  expect(await revealing).toMatchObject({
    ok: false,
    error: { code: 'agent_session_close_pending' }
  })
  expect(store.listVisibleSessionIds()).toEqual([])
  expect((await snapshot()).tabs).toEqual([])
})
