import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { restoreStructuredAgentSessionTabPublications } from '../../structured-agent-session-tab-restoration'
import {
  WORKTREE,
  call,
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

const OTHER = 'second-restoration-target'

async function saveTargets() {
  for (const sessionId of [HOST_TEST_SESSION, OTHER]) {
    await createChat(sessionId)
    await host.close(sessionId, 'user-close')
    runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
  }
}

function restoreTargets() {
  return restoreStructuredAgentSessionTabPublications({
    runtime,
    getHost: () => host,
    profileIds: [HOST_TEST_SESSION, OTHER],
    hydrate: () => {},
    project: (session) =>
      runtime.projectStructuredAgentSessionTab({ ...session, activate: false, notify: false })
  })
}

function closeFirst() {
  return call('session.tabs.close', {
    worktree: WORKTREE,
    tabId: `agent-session:${HOST_TEST_SESSION}`,
    reason: 'user'
  })
}

it('closing one target during recovery preserves the other target and its saved visibility', async () => {
  await saveTargets()
  const reached = deferred()
  const release = deferred()
  const state = host.collaboratorsForTests().runtimeState
  const recovery = state.resolveRecovery.bind(state)
  vi.spyOn(state, 'resolveRecovery').mockImplementationOnce(async (sessionId) => {
    reached.resolve()
    await release.promise
    return recovery(sessionId)
  })
  const restoring = restoreTargets()
  await reached.promise
  try {
    expect(await closeFirst()).toMatchObject({ ok: true })
  } finally {
    release.resolve()
  }
  await restoring
  expect(store.listVisibleSessionIds()).toEqual([OTHER])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([`agent-session:${OTHER}`])
})

it('a close after an admitted migration seed cancels projection and keeps the other chat', async () => {
  await saveTargets()
  const index = host.getPersistedVisibleSessionTabIndex.bind(host)
  vi.spyOn(host, 'getPersistedVisibleSessionTabIndex')
    .mockReturnValueOnce({ present: false, sessionIds: [] })
    .mockReturnValueOnce({ present: false, sessionIds: [] })
    .mockImplementation(index)
  const reached = deferred()
  const release = deferred()
  const seed = host.showSessionTabs.bind(host)
  vi.spyOn(host, 'showSessionTabs').mockImplementationOnce(async (sessionIds) => {
    await seed(sessionIds)
    reached.resolve()
    await release.promise
  })
  const restoring = restoreTargets()
  await reached.promise
  try {
    expect(await closeFirst()).toMatchObject({ ok: true })
  } finally {
    release.resolve()
  }
  await restoring
  expect(store.listVisibleSessionIds()).toEqual([OTHER])
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([`agent-session:${OTHER}`])
})

it('an authoritative empty index leaves historical open conversations hidden', async () => {
  await saveTargets()
  await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
  await host.setSessionTabVisibility(OTHER, false)
  await host.revealSession(HOST_TEST_SESSION)
  await restoreTargets()
  expect(store.listVisibleSessionIds()).toEqual([])
  expect((await snapshot()).tabs).toEqual([])
})
