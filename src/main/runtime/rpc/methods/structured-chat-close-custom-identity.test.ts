import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
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
async function graphTab(tabId: string, sessionId = HOST_TEST_SESSION) {
  const saved = await snapshot()
  const source = saved.tabs.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === sessionId
  )
  if (!source) {
    throw new Error('chat missing')
  }
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [{ ...saved, tabs: [{ ...source, id: tabId }] }]
  })
}
function close(tabId: string) {
  return call('session.tabs.close', { worktree: WORKTREE, tabId, reason: 'user' })
}
function holdCensus() {
  const reached = deferred()
  const release = deferred()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the existing census await is controlled to establish close ordering.
  const internal = runtime as unknown as {
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'refreshMobileSessionPtyRecords')
    .mockImplementationOnce(async () => {
      reached.resolve()
      await release.promise
      return new Set()
    })
    .mockResolvedValue(new Set())
  return { reached, release }
}
function relay(closeSessionTab: () => Promise<void>) {
  runtime.setNotifier({
    closeSessionTab,
    closeTerminal: () => {},
    worktreesChanged: () => {},
    reposChanged: () => {},
    activateWorktree: () => {},
    createTerminal: () => {},
    splitTerminal: () => {},
    renameTerminal: () => {},
    focusTerminal: () => {},
    sleepWorktree: () => {},
    terminalFitOverrideChanged: () => {},
    terminalDriverChanged: () => {}
  })
}

it.each([false, true])(
  'an earlier custom-listed close cannot erase a later explicit reveal, graph-only=%s',
  async (graphOnly) => {
    await createChat(HOST_TEST_SESSION, graphOnly ? undefined : 'custom-chat-tab')
    await graphTab('custom-chat-tab')
    const { reached, release } = holdCensus()
    const closing = close('custom-chat-tab')
    await reached.promise
    const revealing = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
    try {
      await Promise.race([revealing, new Promise<void>((resolve) => setTimeout(resolve, 100))])
    } finally {
      release.resolve()
    }
    expect(await closing).toMatchObject({ ok: true, result: { closed: true } })
    expect(await revealing).toMatchObject({ ok: true, result: { ok: true } })
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  }
)

it.each([
  { boundary: 'census', graphOnly: false },
  { boundary: 'relay', graphOnly: false },
  { boundary: 'census', graphOnly: true },
  { boundary: 'relay', graphOnly: true }
])(
  'a custom tab retargeted during $boundary does not authorize closing its replacement, graph-only=$graphOnly',
  async ({ boundary, graphOnly }) => {
    await createChat(HOST_TEST_SESSION, 'custom-chat-tab')
    await graphTab('custom-chat-tab')
    const gate = boundary === 'census' ? holdCensus() : { reached: deferred(), release: deferred() }
    if (boundary === 'relay') {
      relay(async () => {
        gate.reached.resolve()
        await gate.release.promise
      })
    }
    const closing = close('custom-chat-tab')
    await gate.reached.promise
    await createChat('replacement-chat')
    if (!graphOnly) {
      await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
      await host.setSessionTabVisibility('replacement-chat', false)
      await host.setSessionTabVisibility('replacement-chat', true, 'custom-chat-tab')
    }
    await graphTab('custom-chat-tab', 'replacement-chat')
    const stop = vi.spyOn(host, 'close')
    gate.release.resolve()
    expect(await closing).toMatchObject({ ok: false })
    expect(stop).not.toHaveBeenCalled()
    expect(store.listVisibleSessionIds()).toEqual(
      graphOnly ? [HOST_TEST_SESSION, 'replacement-chat'] : ['replacement-chat']
    )
  }
)

it('a graph-owned prefix-shaped alias closes its original conversation even if the listed alias disappears', async () => {
  const alias = 'agent-session:different-spelling'
  expect((await createChat(HOST_TEST_SESSION)).ok).toBe(true)
  await graphTab(alias)
  const reached = deferred()
  const release = deferred()
  const ensure = runtime.ensureStructuredAgentSessionHostForClose.bind(runtime)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHostForClose').mockImplementationOnce(async () => {
    reached.resolve()
    await release.promise
    await ensure()
  })
  const closing = close(alias)
  await reached.promise
  runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
  release.resolve()
  expect(await closing).toMatchObject({ ok: true })
  expect(store.listVisibleSessionIds()).toEqual([])
  expect(host.listSessionTabs().map((tab) => tab.sessionId)).not.toContain(HOST_TEST_SESSION)
})

it('a custom listed pin veto leaves visibility and later publication intact', async () => {
  await createChat(HOST_TEST_SESSION, 'custom-chat-tab')
  await graphTab('custom-chat-tab')
  relay(async () => {
    throw new Error('session_tab_close_canceled')
  })
  const stop = vi.spyOn(host, 'close')
  expect(await close('custom-chat-tab')).toMatchObject({ ok: false })
  expect(stop).not.toHaveBeenCalled()
  expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true
  })
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
})
