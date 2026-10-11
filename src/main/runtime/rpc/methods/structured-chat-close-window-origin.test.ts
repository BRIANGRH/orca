import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { registerRuntimeWindowLifecycle } from '../../../window/runtime-window-lifecycle'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
import {
  WORKTREE,
  call,
  closeSession,
  createChat,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
vi.mock('../../../ipc/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: vi.fn()
}))
vi.mock('../../../window/mobile-markdown-request-relay', () => ({
  requestMobileMarkdownFromRenderer: vi.fn()
}))
vi.mock('../../../window/renderer-document-navigation', () => ({
  registerRendererDocumentNavigation: vi.fn()
}))
vi.mock('../../../window/terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this file's Electron boundary supplies a real EventEmitter.
const responses = ipcMain as unknown as EventEmitter
afterEach(() => {
  vi.useRealTimers()
  responses.removeAllListeners()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function attachWindow() {
  const state = { destroyed: false }
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed,
    send: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => state.destroyed,
    webContents
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration and the real close relay read only these window members.
  registerRuntimeWindowLifecycle(window as unknown as BrowserWindow, runtime)
  return { window, webContents, state }
}

const desktop: RpcDispatchStreamingOptions = {
  caller: { kind: 'desktop' },
  clientKind: 'runtime',
  originatingWindowId: 1,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

function closeChat(
  context: RpcDispatchStreamingOptions = desktop,
  reason: 'user' | null = 'user',
  tabId = `agent-session:${HOST_TEST_SESSION}`
) {
  return call(
    'session.tabs.close',
    { worktree: WORKTREE, tabId, reason: reason ?? undefined, originatingWindowId: 1 },
    context
  )
}

async function veto(webContents: ReturnType<typeof attachWindow>['webContents']) {
  await vi.waitFor(() =>
    expect(webContents.send).toHaveBeenCalledWith('ui:sessionTabCloseRequest', expect.anything())
  )
  const payload: unknown = webContents.send.mock.calls.find(
    ([channel]) => channel === 'ui:sessionTabCloseRequest'
  )?.[1]
  if (!payload || typeof payload !== 'object' || !('requestId' in payload)) {
    throw new Error('missing close request')
  }
  responses.emit(
    'ui:sessionTabCloseResponse',
    { sender: webContents },
    { requestId: payload.requestId, error: 'session_tab_close_canceled' }
  )
}

it.each([false, true])(
  'preserves the initiating window after slow admission even when destroyed %s',
  async (destroyed) => {
    await createChat(HOST_TEST_SESSION)
    const { webContents, state } = attachWindow()
    const reached = deferred()
    const release = deferred()
    const inventory = runtime.listMobileSessionTabsForChatClose.bind(runtime)
    vi.spyOn(runtime, 'listMobileSessionTabsForChatClose').mockImplementation(async (...args) => {
      reached.resolve()
      await release.promise
      return inventory(...args)
    })
    const closing = closeChat()
    await reached.promise
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(16_000)
    state.destroyed = destroyed
    release.resolve()
    expect(await closing).toMatchObject({ ok: true, result: { closed: true } })
    expect(
      webContents.send.mock.calls.filter(([channel]) => channel === 'ui:sessionTabCloseRequest')
    ).toEqual([])
    expect(responses.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
    expect(closeSession).toHaveBeenCalledOnce()
    expect(store.listVisibleSessionIds()).toEqual([])
    expect((await snapshot()).tabs).toEqual([])
  }
)

it.each([
  { ...desktop, originatingWindowId: 2 },
  { ...desktop, caller: { kind: 'local-cli' as const } },
  { ...desktop, caller: { kind: 'paired-device' as const, deviceId: 'paired' } },
  { ...desktop, caller: undefined },
  { ...desktop, clientKind: 'mobile' as const },
  { ...desktop, originatingWindowId: undefined }
])('keeps renderer veto for callers outside the initiating desktop window: %j', async (context) => {
  await createChat(HOST_TEST_SESSION)
  const { webContents } = attachWindow()
  const closing = closeChat(context)
  await veto(webContents)
  expect(await closing).toMatchObject({
    ok: false,
    error: { message: 'session_tab_close_canceled' }
  })
  expect(closeSession).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  expect(responses.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  expect(webContents.listenerCount('destroyed')).toBe(0)
})

it('does not treat a legacy unattributed request as originating desktop intent', async () => {
  await createChat(HOST_TEST_SESSION)
  const { webContents } = attachWindow()
  const closing = closeChat(desktop, null)
  await veto(webContents)
  expect(await closing).toMatchObject({ ok: false })
  expect(closeSession).not.toHaveBeenCalled()
})

it('carries origin through the later listed-chat branch for a custom tab id', async () => {
  await createChat(HOST_TEST_SESSION, 'custom-chat-tab')
  const { webContents } = attachWindow()
  expect(await closeChat(desktop, 'user', 'custom-chat-tab')).toMatchObject({
    ok: true,
    result: { closed: true }
  })
  expect(
    webContents.send.mock.calls.filter(([channel]) => channel === 'ui:sessionTabCloseRequest')
  ).toEqual([])
  expect(closeSession).toHaveBeenCalledOnce()
  expect(store.listVisibleSessionIds()).toEqual([])
})

it('another window can still veto while the originating request is awaiting admission', async () => {
  await createChat(HOST_TEST_SESSION)
  const { webContents } = attachWindow()
  const reached = deferred()
  const release = deferred()
  const inventory = runtime.listMobileSessionTabsForChatClose.bind(runtime)
  vi.spyOn(runtime, 'listMobileSessionTabsForChatClose').mockImplementationOnce(async (...args) => {
    reached.resolve()
    await release.promise
    return inventory(...args)
  })
  const original = closeChat()
  await reached.promise
  try {
    const other = closeChat({ ...desktop, originatingWindowId: 2 })
    await veto(webContents)
    expect(await other).toMatchObject({ ok: false })
    expect(closeSession).not.toHaveBeenCalled()
  } finally {
    release.resolve()
  }
  expect(await original).toMatchObject({ ok: true, result: { closed: true } })
  expect(closeSession).toHaveBeenCalledOnce()
})

it.each(['file', 'browser', 'cleanup'] as const)(
  'retains the ordinary renderer relay for %s despite local origin metadata',
  async (kind) => {
    await createChat(HOST_TEST_SESSION)
    const saved = await snapshot()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the existing snapshot map and terminal census are controlled for these nonterminal paths.
    const internal = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
    }
    vi.spyOn(internal, 'refreshMobileSessionPtyRecords').mockResolvedValue(new Set())
    if (kind !== 'cleanup') {
      const tab =
        kind === 'file'
          ? {
              type: 'file' as const,
              id: 'other-tab',
              title: 'file',
              filePath: '/repo/file.ts',
              relativePath: 'file.ts',
              language: 'typescript',
              isDirty: false,
              isActive: true
            }
          : {
              type: 'browser' as const,
              id: 'other-tab',
              title: 'browser',
              browserWorkspaceId: 'browser',
              browserPageId: null,
              url: 'https://example.test',
              loading: false,
              canGoBack: false,
              canGoForward: false,
              isActive: true
            }
      internal.mobileSessionTabsByWorktree.set(saved.worktree, { ...saved, tabs: [tab] })
    }
    const { webContents } = attachWindow()
    const closing = runtime.closeMobileSessionTab(
      WORKTREE,
      kind === 'cleanup' ? `agent-session:${HOST_TEST_SESSION}` : 'other-tab',
      { reason: kind === 'cleanup' ? 'cleanup' : 'user', originatingWindowId: 1 }
    )
    const rejection = expect(closing).rejects.toThrow('session_tab_close_canceled')
    await veto(webContents)
    await rejection
    expect(closeSession).not.toHaveBeenCalled()
    expect(responses.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  }
)
