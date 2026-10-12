import { expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  WORKTREE,
  call,
  createChat,
  host,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

async function unloadSavedChat() {
  await createChat(HOST_TEST_SESSION)
  await host.close(HOST_TEST_SESSION, 'user-close')
  runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
  setStructuredAgentSessionHost(null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's protected persistence and terminal-census methods.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'hasPersistedStructuredAgentSessionStore').mockReturnValue(true)
  const census = vi
    .spyOn(internal, 'refreshMobileSessionPtyRecords')
    .mockImplementation(async () => {
      throw new Error('chat close must not scan terminals')
    })
  vi.spyOn(runtime, 'prepareStructuredAgentSessionStartupRestoration').mockResolvedValue()
  const install = vi
    .spyOn(runtime, 'ensureStructuredAgentSessionHost')
    .mockImplementation(async () => {
      setStructuredAgentSessionHost(host)
    })
  return { install, census }
}

it('closes idempotently without installing a host when no saved chat store exists', async () => {
  expect(store.listRecords()).toEqual([])
  setStructuredAgentSessionHost(null)
  Object.assign(runtime, { hasPersistedStructuredAgentSessionStore: () => false })
  const install = vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  const stop = vi.spyOn(host, 'close')

  expect(await call('agentSession.close', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(install).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(store.listRecords()).toEqual([])
})

function closeChat(
  worktree = WORKTREE,
  clientCapabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
) {
  return call(
    'session.tabs.close',
    { worktree, tabId: `agent-session:${HOST_TEST_SESSION}`, reason: 'user' },
    { clientKind: 'runtime', clientCapabilities }
  )
}

it('installs an unloaded owner and hides its saved chat before acknowledging close', async () => {
  const { install, census } = await unloadSavedChat()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])

  expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })

  expect(install).toHaveBeenCalledOnce()
  expect(census).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([])
  census.mockResolvedValue(null)
  expect((await snapshot()).tabs).toEqual([])
})

it('answers retryably when the saved owner cannot install, and a later close can succeed', async () => {
  const { install, census } = await unloadSavedChat()
  install.mockRejectedValueOnce(new Error('temporary record-store failure'))

  expect(await closeChat()).toMatchObject({
    ok: false,
    error: { code: 'agent_session_close_pending' }
  })
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  expect(census).not.toHaveBeenCalled()
  expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
  expect(store.listVisibleSessionIds()).toEqual([])
})

it('checks the saved workspace after installation, before hiding or stopping the chat', async () => {
  const { install } = await unloadSavedChat()
  const stop = vi.spyOn(host, 'close')

  expect(await closeChat('id:another-worktree')).toMatchObject({
    ok: false,
    error: { code: 'agent_session_worktree_mismatch' }
  })
  expect(install).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
})

it('checks the saved agent audience after installation before hiding or stopping', async () => {
  await unloadSavedChat()
  vi.spyOn(host, 'sessionAgent').mockReturnValue('claude')
  const stop = vi.spyOn(host, 'close')

  expect(await closeChat()).toMatchObject({ ok: false, error: { message: 'tab_not_found' } })
  expect(stop).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
})

it('does not install a saved owner for a client without structured chats', async () => {
  const { install } = await unloadSavedChat()

  expect(await closeChat(WORKTREE, [])).toMatchObject({
    ok: false,
    error: { message: 'tab_not_found' }
  })
  expect(install).not.toHaveBeenCalled()
})
