import { beforeAll, expect, it, vi } from 'vitest'
import { registerMainProcessIpcHandlers } from '../../../startup/main-process-ipc-bootstrap'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
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

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, () => Promise<unknown>>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler)
  }
}))
vi.mock('../../../startup/main-process-state', () => ({
  mainProcessState: {
    get runtime() {
      return runtime
    },
    firstWindowStartupServicesReady: Promise.resolve(),
    managedWslCliStartupBarrierReady: Promise.resolve()
  }
}))
vi.mock('../../../startup/legacy-worker-renderer-recovery', () => ({
  recoverLegacyWorkerTerminalsForRendererStartup: vi.fn()
}))
vi.mock('../../../startup/startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('../../../startup/os-opened-documents', () => ({ resolveOsOpenedDocuments: vi.fn() }))
vi.mock('../../saved-structured-agent-session-restoration', () => ({
  collectSavedStructuredAgentSessionIds: () => ['session-alpha', 'second-startup-entry-chat']
}))
beforeAll(registerMainProcessIpcHandlers)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function prepareViaIpc() {
  const handler = handlers.get('app:prepareTerminalStartupRestoration')
  if (!handler) {
    throw new Error('startup handler missing')
  }
  return handler()
}
function controlPreparation() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: controls only the existing persistence predicate and terminal census.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'hasPersistedStructuredAgentSessionStore').mockReturnValue(true)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  return vi.spyOn(internal, 'refreshMobileSessionPtyRecords').mockResolvedValue(null)
}
async function saveChats(legacy = false) {
  for (const sessionId of legacy
    ? [HOST_TEST_SESSION, 'second-startup-entry-chat']
    : [HOST_TEST_SESSION]) {
    expect((await createChat(sessionId)).ok).toBe(true)
    await host.close(sessionId, 'user-close')
    runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
  }
  if (legacy) {
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      delete persisted.sessionTabs
    })
    await openHost()
  }
}

it.each([
  { legacy: false, entry: 'IPC' },
  { legacy: true, entry: 'IPC' },
  { legacy: false, entry: 'public' },
  { legacy: true, entry: 'public' }
])(
  'the actual startup $entry owns restoration before close, legacy=$legacy',
  async ({ legacy, entry }) => {
    await saveChats(legacy)
    const reached = deferred()
    const release = deferred()
    controlPreparation().mockImplementationOnce(async () => {
      reached.resolve()
      await release.promise
      return null
    })
    const preparing =
      entry === 'IPC' ? prepareViaIpc() : runtime.prepareStructuredAgentSessionStartupRestoration()
    await reached.promise
    if (!legacy) {
      vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk failure'))
    }
    try {
      expect(
        await call('session.tabs.close', {
          worktree: WORKTREE,
          tabId: `agent-session:${HOST_TEST_SESSION}`,
          reason: 'user'
        })
      ).toMatchObject({ ok: true, result: { closed: true } })
    } finally {
      release.resolve()
      await preparing
    }
    const first = runtime.restoreStructuredAgentSessionTabs()
    expect(runtime.restoreStructuredAgentSessionTabs()).toBe(first)
    await first
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual(
      legacy ? ['agent-session:second-startup-entry-chat'] : []
    )
    if (legacy) {
      expect(store.listVisibleSessionIds()).toEqual(['second-startup-entry-chat'])
    }
  }
)

it('the terminal gate resolves while history is held and the full owner finishes without a later renderer request', async () => {
  await saveChats()
  controlPreparation()
  const reached = deferred()
  const release = deferred()
  const readHistory = host.restoreReadableSessions.bind(host)
  const history = vi.spyOn(host, 'restoreReadableSessions').mockImplementation(async (ids) => {
    reached.resolve()
    await release.promise
    await readHistory(ids)
  })
  try {
    await prepareViaIpc()
    await reached.promise
    expect(history).toHaveBeenCalledOnce()
    expect((await snapshot()).tabs).toEqual([])
  } finally {
    release.resolve()
  }
  await vi.waitFor(async () =>
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  )
  expect(history).toHaveBeenCalledOnce()
})

it('a failed preparation reports once for joined callers and immediately retries with fresh ownership', async () => {
  await saveChats()
  const census = controlPreparation().mockRejectedValueOnce(new Error('census unavailable'))
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const failed = await Promise.allSettled([prepareViaIpc(), prepareViaIpc()])
  expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  await prepareViaIpc()
  await runtime.restoreStructuredAgentSessionTabs()
  expect(census).toHaveBeenCalledTimes(2)
  expect(
    warnings.mock.calls.filter(
      ([message]) => message === '[runtime] restoring saved chat tabs failed'
    )
  ).toHaveLength(1)
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
    `agent-session:${HOST_TEST_SESSION}`
  ])
})

it('a background history failure ends the owner and allows later inventory to retry', async () => {
  await saveChats()
  controlPreparation()
  const history = vi
    .spyOn(host, 'restoreReadableSessions')
    .mockRejectedValueOnce(new Error('history unavailable'))
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await prepareViaIpc()
  await vi.waitFor(() =>
    expect(warnings).toHaveBeenCalledWith(
      '[runtime] restoring saved chat tabs failed',
      expect.objectContaining({ message: 'history unavailable' })
    )
  )
  await runtime.restoreStructuredAgentSessionTabs()
  expect(history).toHaveBeenCalledTimes(2)
  expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
    `agent-session:${HOST_TEST_SESSION}`
  ])
})
