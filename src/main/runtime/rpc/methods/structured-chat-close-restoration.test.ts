import { afterEach, expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'
import {
  WORKTREE,
  acquisitions,
  call,
  caller,
  closeSession,
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

afterEach(() => vi.useRealTimers())

function closeChat() {
  return call('session.tabs.close', {
    worktree: WORKTREE,
    tabId: `agent-session:${HOST_TEST_SESSION}`,
    reason: 'user'
  })
}

it('legacy close cancels a create held before lazy host installation, then permits a fresh create', async () => {
  setStructuredAgentSessionHost(null)
  const reached = deferred()
  const release = deferred()
  const intent = hostTestAttachParams(null)
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(async () => {
    reached.resolve()
    await release.promise
    return intent
  })
  const creating = createStructuredAgentSessionForWorktree({
    runtime,
    caller,
    ensureHost: async () => {
      setStructuredAgentSessionHost(host)
      return host
    },
    envelope: intent.envelope,
    worktree: WORKTREE,
    agent: 'codex',
    activate: true
  })
  await reached.promise
  try {
    expect(await call('agentSession.close', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true
    })
  } finally {
    release.resolve()
  }
  expect((await creating).ok).toBe(false)
  expect(acquisitions).toBe(0)
  expect(store.getRecord(HOST_TEST_SESSION)).toBeNull()
  expect((await createChat(HOST_TEST_SESSION)).ok).toBe(true)
  expect(acquisitions).toBe(1)
})

it('legacy close installs an unloaded saved owner and hides it without a terminal census', async () => {
  await createChat(HOST_TEST_SESSION)
  await host.close(HOST_TEST_SESSION, 'user-close')
  runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
  setStructuredAgentSessionHost(null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the protected persistence predicate and census are mocked.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'hasPersistedStructuredAgentSessionStore').mockReturnValue(true)
  const census = vi
    .spyOn(internal, 'refreshMobileSessionPtyRecords')
    .mockRejectedValue(new Error('close must not scan terminals'))
  const install = vi
    .spyOn(runtime, 'ensureStructuredAgentSessionHost')
    .mockImplementation(async () => {
      setStructuredAgentSessionHost(host)
    })
  expect(await call('agentSession.close', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true
  })
  expect(install).toHaveBeenCalledOnce()
  expect(census).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([])
  census.mockResolvedValue(null)
  expect((await snapshot()).tabs).toEqual([])
})

it.each([false, true])(
  'a completed unlisted close cancels older restoration even with visibility-write failure %s',
  async (writeFails) => {
    await createChat(HOST_TEST_SESSION)
    await host.close(HOST_TEST_SESSION, 'user-close')
    runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
    vi.spyOn(runtime, 'prepareStructuredAgentSessionStartupRestoration').mockResolvedValue()
    const reached = deferred()
    const release = deferred()
    const state = host.collaboratorsForTests().runtimeState
    const recovery = state.resolveRecovery.bind(state)
    vi.spyOn(state, 'resolveRecovery').mockImplementation(async (sessionId) => {
      reached.resolve()
      await release.promise
      return recovery(sessionId)
    })
    const restoring = runtime.restoreStructuredAgentSessionTabs()
    await reached.promise
    if (writeFails) {
      vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk failure'))
    }
    try {
      expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
    } finally {
      release.resolve()
    }
    await restoring
    expect((await snapshot()).tabs).toEqual([])
    if (!writeFails) {
      expect(store.listVisibleSessionIds()).toEqual([])
      expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
        ok: true,
        result: { ok: true }
      })
      expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    }
  }
)

it('a reveal resolves with a plain retry within its own bound when a provider close never settles', async () => {
  await createChat(HOST_TEST_SESSION)
  const stopping = deferred()
  const release = deferred()
  closeSession.mockImplementationOnce(async () => {
    stopping.resolve()
    await release.promise
    return true
  })
  const closing = closeChat()
  await stopping.promise
  vi.useFakeTimers()
  const revealing = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
  try {
    await vi.advanceTimersByTimeAsync(3_001)
    expect(await revealing).toMatchObject({
      ok: false,
      error: { code: 'agent_session_close_pending' }
    })
    expect(store.listVisibleSessionIds()).toEqual([])
    expect(acquisitions).toBe(1)
  } finally {
    vi.useRealTimers()
    release.resolve()
    await closing
  }
})
