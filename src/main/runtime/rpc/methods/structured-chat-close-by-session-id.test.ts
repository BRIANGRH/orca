import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-close-capabilities'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS } from './structured-agent-session-reveal'
import {
  WORKTREE,
  acquisitions,
  call,
  createChat,
  host,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

const CHAT_TAB = `agent-session:${HOST_TEST_SESSION}`
// The window and a paired desktop both close as a runtime client that reads chats.
const WINDOW = {
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY
  ]
}

function closeTab(worktree = WORKTREE, tabId = CHAT_TAB) {
  return call('session.tabs.close', { worktree, tabId, reason: 'user' }, WINDOW)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function relayWindowClose(relay: () => Promise<void> = async () => {}) {
  const closeSessionTab = vi.fn(relay)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat close path uses only this relay.
  runtime.setNotifier({ closeSessionTab } as never)
  return closeSessionTab
}

async function settleTicks(count = 20): Promise<void> {
  for (let tick = 0; tick < count; tick++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function listedChatIds(): Promise<string[]> {
  return (await snapshot()).tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.id] : []))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('agentSession.close', () => {
  it('stops the chat and drops its tab when the restore index cannot be written', async () => {
    await createChat(HOST_TEST_SESSION)
    vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk I/O error'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const close = vi.spyOn(host, 'close')

    expect(await call('agentSession.close', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true
    })

    expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
    expect(await listedChatIds()).toEqual([])
  })
})

describe('session.tabs.close for a chat the host does not list', () => {
  it('closes it by session id: hidden in the restore index and stopped, with no window relay', async () => {
    await createChat(HOST_TEST_SESSION)
    // As before restore publishes it: the record exists, the list does not carry the tab.
    runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
    const relay = relayWindowClose()
    const close = vi.spyOn(host, 'close')

    expect(await closeTab()).toMatchObject({ ok: true, result: { closed: true } })

    expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
    expect(store.listVisibleSessionIds()).toEqual([])
    expect(relay).not.toHaveBeenCalled()
  })

  it('answers tab_not_found for a chat of another worktree, stopping nothing', async () => {
    await createChat(HOST_TEST_SESSION)
    runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
    const close = vi.spyOn(host, 'close')

    expect(await closeTab('id:another-worktree')).toMatchObject({
      ok: false,
      error: { message: 'tab_not_found' }
    })

    expect(close).not.toHaveBeenCalled()
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  })

  it('answers closed when no structured host is installed', async () => {
    setStructuredAgentSessionHost(null)

    expect(await closeTab()).toMatchObject({ ok: true, result: { closed: true } })
  })

  it('aborts a chat still starting, before it has a record', async () => {
    const reachedLaunchArgs = deferred()
    const releaseLaunchArgs = deferred()
    host.deps.resolveLaunchArgs = async () => {
      reachedLaunchArgs.resolve()
      await releaseLaunchArgs.promise
      return undefined
    }
    const created = createChat(HOST_TEST_SESSION)
    await reachedLaunchArgs.promise
    expect(store.getRecord(HOST_TEST_SESSION)).toBeNull()

    const closed = closeTab()
    await settleTicks()
    releaseLaunchArgs.resolve()

    expect(await closed).toMatchObject({ ok: true, result: { closed: true } })
    expect(
      await created.then(
        (outcome) => outcome.ok,
        () => false
      )
    ).toBe(false)
    expect(acquisitions).toBe(0)
    expect(await listedChatIds()).toEqual([])
  })
})

describe('session.tabs.close for a listed chat', () => {
  it('still asks the window first, then drops the tab and stops the chat', async () => {
    await createChat(HOST_TEST_SESSION)
    const relay = relayWindowClose()
    const close = vi.spyOn(host, 'close')

    expect(await closeTab()).toMatchObject({ ok: true, result: { closed: true } })

    expect(relay).toHaveBeenCalledWith(CHAT_TAB, HOST_TEST_LOCATION.workspaceId)
    expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
    expect(await listedChatIds()).toEqual([])
  })

  it('does not wait behind the terminal process scan', async () => {
    await createChat(HOST_TEST_SESSION)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's own protected scan, stubbed to a scan that never answers.
    const internal = runtime as unknown as {
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    }
    vi.spyOn(internal, 'refreshMobileSessionPtyRecords').mockReturnValue(new Promise(() => {}))

    const outcome = await Promise.race([
      closeTab(),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000))
    ])

    expect(outcome).toMatchObject({ ok: true, result: { closed: true } })
  })
})

describe('an older client closing a chat with both commands at once', () => {
  it('stays idempotent: both answer, the chat is stopped, hidden and unlisted', async () => {
    await createChat(HOST_TEST_SESSION)
    const close = vi.spyOn(host, 'close')

    const [byId, byTab] = await Promise.all([
      call('agentSession.close', { sessionId: HOST_TEST_SESSION }, WINDOW),
      closeTab()
    ])

    expect(byId).toMatchObject({ ok: true })
    expect(byTab).toMatchObject({ ok: true, result: { closed: true } })
    expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
    expect(store.listVisibleSessionIds()).toEqual([])
    expect(await listedChatIds()).toEqual([])
  })
})

describe('agentSession.reveal during a close of the same chat', () => {
  it('waits for the close, then shows the chat', async () => {
    await createChat(HOST_TEST_SESSION)
    const windowAnswers = deferred()
    relayWindowClose(() => windowAnswers.promise)

    // Same tick: the close is marked in flight on arrival, before any of its awaits.
    const closed = closeTab()
    let revealAnswered = false
    const revealed = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION }).then(
      (response) => {
        revealAnswered = true
        return response
      }
    )
    await settleTicks()
    expect(revealAnswered).toBe(false)
    windowAnswers.resolve()

    expect(await closed).toMatchObject({ ok: true, result: { closed: true } })
    expect(await revealed).toMatchObject({ ok: true, result: { ok: true } })
    expect(await listedChatIds()).toEqual([CHAT_TAB])
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  })

  it('fails the reveal once the close outlives the bound', async () => {
    await createChat(HOST_TEST_SESSION)
    const windowAnswers = deferred()
    relayWindowClose(() => windowAnswers.promise)
    const closed = closeTab()
    await settleTicks()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const revealed = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS)
    vi.useRealTimers()

    expect(await revealed).toMatchObject({
      ok: false,
      error: { message: 'agent_session_close_pending' }
    })
    windowAnswers.resolve()
    expect(await closed).toMatchObject({ ok: true, result: { closed: true } })
  })
})

describe('the host capability', () => {
  it('advertises closing a chat by session id', () => {
    expect(RUNTIME_CAPABILITIES).toContain(
      SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY
    )
    expect(SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY).toBe(
      'session-tabs.close-agent-session-by-id.v1'
    )
  })
})
