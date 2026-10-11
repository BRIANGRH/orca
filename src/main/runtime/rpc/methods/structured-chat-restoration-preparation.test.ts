import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { editPersistedTestAgentSessionStore } from '../../agent-session-record-store-test-harness'
import {
  WORKTREE,
  call,
  createChat,
  directory,
  host,
  openHost,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

vi.mock('../../saved-structured-agent-session-restoration', () => ({
  collectSavedStructuredAgentSessionIds: () => ['session-alpha', 'second-legacy-chat']
}))

const OTHER = 'second-legacy-chat'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function saveChats(legacy = false) {
  for (const sessionId of legacy ? [HOST_TEST_SESSION, OTHER] : [HOST_TEST_SESSION]) {
    await createChat(sessionId)
    await host.close(sessionId, 'user-close')
    runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
  }
  if (legacy) {
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      delete persisted.sessionTabs
    })
    await openHost()
    expect(host.getPersistedVisibleSessionTabIndex()).toEqual({ present: false, sessionIds: [] })
  }
}

function controlPreparation() {
  const reached = deferred()
  const release = deferred()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the existing persistence predicate and actual preparation census are controlled.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'hasPersistedStructuredAgentSessionStore').mockReturnValue(true)
  const census = vi
    .spyOn(internal, 'refreshMobileSessionPtyRecords')
    .mockImplementationOnce(async () => {
      reached.resolve()
      await release.promise
      return null
    })
    .mockResolvedValue(null)
  const install = vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  return { reached, release, install, census }
}

function closeChat(legacy = false) {
  return legacy
    ? call('agentSession.close', { sessionId: HOST_TEST_SESSION })
    : call('session.tabs.close', {
        worktree: WORKTREE,
        tabId: `agent-session:${HOST_TEST_SESSION}`,
        reason: 'user'
      })
}

it.each([false, true])(
  'an older actual startup census cannot revive a completed close, failed hide=%s',
  async (writeFails) => {
    await saveChats()
    const { reached, release } = controlPreparation()
    const restoring = runtime.restoreStructuredAgentSessionTabs()
    await reached.promise
    if (writeFails) {
      vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk failure'))
    }
    let closed: Awaited<ReturnType<typeof call>>
    try {
      closed = await closeChat()
    } finally {
      release.resolve()
    }
    await restoring
    expect(closed).toMatchObject({ ok: true, result: { closed: true } })
    expect((await snapshot()).tabs).toEqual([])
  }
)

it('keeps the other legacy target when a close creates an empty index during census', async () => {
  await saveChats(true)
  const { reached, release } = controlPreparation()
  const restoring = runtime.restoreStructuredAgentSessionTabs()
  await reached.promise
  let closed: Awaited<ReturnType<typeof call>>
  try {
    closed = await closeChat()
  } finally {
    release.resolve()
  }
  await restoring
  expect(closed).toMatchObject({ ok: true })
  expect(store.listVisibleSessionIds()).toEqual([OTHER])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([`agent-session:${OTHER}`])
})

it.each([false, true])(
  'a close before lazy installation cancels its unknown target and preserves initial membership, legacy=%s',
  async (legacy) => {
    await saveChats(legacy)
    const { reached, release, install } = controlPreparation()
    const installing = deferred()
    const allowInstall = deferred()
    setStructuredAgentSessionHost(null)
    install.mockImplementation(async () => {
      installing.resolve()
      await allowInstall.promise
      setStructuredAgentSessionHost(host)
    })
    const restoring = runtime.restoreStructuredAgentSessionTabs()
    await installing.promise
    if (!legacy) {
      vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk failure'))
    }
    const closing = closeChat(true)
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2))
    let closed: Awaited<ReturnType<typeof call>>
    try {
      allowInstall.resolve()
      await reached.promise
      closed = await closing
    } finally {
      allowInstall.resolve()
      release.resolve()
    }
    await restoring
    expect(closed).toMatchObject({ ok: true })
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual(
      legacy ? [`agent-session:${OTHER}`] : []
    )
    if (legacy) {
      expect(store.listVisibleSessionIds()).toEqual([OTHER])
    }
  }
)

it('an explicit later reveal survives the canceled older preparation', async () => {
  await saveChats()
  const { reached, release } = controlPreparation()
  const restoring = runtime.restoreStructuredAgentSessionTabs()
  await reached.promise
  try {
    expect(await closeChat()).toMatchObject({ ok: true })
    expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true,
      result: { ok: true }
    })
  } finally {
    release.resolve()
  }
  await restoring
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
    `agent-session:${HOST_TEST_SESSION}`
  ])
})

it('failed preparation releases the attempt and a later restore can discover a new host', async () => {
  await saveChats()
  const { release, census } = controlPreparation()
  release.resolve()
  census.mockReset().mockRejectedValueOnce(new Error('census unavailable')).mockResolvedValue(null)
  await expect(runtime.restoreStructuredAgentSessionTabs()).rejects.toThrow('census unavailable')
  setStructuredAgentSessionHost(null)
  await openHost()
  await runtime.restoreStructuredAgentSessionTabs()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
    `agent-session:${HOST_TEST_SESSION}`
  ])
})
