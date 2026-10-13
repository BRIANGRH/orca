// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionRuntimeDeps } from '../../src/main/runtime/structured-agent-session-runtime'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { createStore, closeTestStores, testState } from '../../src/main/persistence-test-harness'
import { RuntimeClientSettingsController } from '../../src/main/runtime/runtime-client-settings'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  install: vi.fn<(deps: StructuredAgentSessionRuntimeDeps) => Promise<void>>(async () => {})
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../../src/main/runtime/structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: mocks.install
}))
vi.mock('@/store', async () => ({
  useAppStore: (await import('@/store/slices/store-test-helpers')).createTestStore()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))
import { useStructuredAgentSessionOptionStamp } from '@/components/native-chat/StructuredAgentSessionStatusBridge'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/use-structured-agent-session-options'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

let rig: RestTestRig | undefined
let stopSettings = (): void => {}
afterEach(async () => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  resetHostModelCatalogSnapshotsForTests()
  stopSettings()
  await closeTestStores()
  await rig?.dispose()
  rig = undefined
  vi.clearAllMocks()
})

it('refreshes a mounted paired viewer before sending when another client changes the owning store', async () => {
  const current = await createRestTestRig()
  rig = current
  testState.dir = current.root
  const owner = createStore()
  owner.updateSettings({ nativeChatPermissionMode: 'ask' })
  const runtime = new OrcaRuntimeService(owner)
  await runtime.ensureStructuredAgentSessionHost()
  const deps = mocks.install.mock.calls[0]?.[0]
  if (!deps?.resolveNewChatPermissionMode || !deps.onNewChatPermissionModeChanged) {
    throw new Error('host permission settings were not wired')
  }
  current.host.deps.newChatPermissionMode = deps.resolveNewChatPermissionMode
  stopSettings = deps.onNewChatPermissionModeChanged(current.host.publishInheritedPermissionModes)
  await foundRestTestChat(current)
  mocks.subscribe.mockImplementation(async (_target, emit) => ({
    unsubscribe: current.host.subscribeStatus({ id: 'paired-viewer', emit })
  }))
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.options' ? current.host.readOptions(SESSION) : { origin: 'unknown' }
  )
  const target = { kind: 'environment', environmentId: 'owning-host' } as const
  const mutate = vi.fn(async () => null)
  const fence = current.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const { result } = renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'codex',
      sessionId: SESSION,
      target,
      transportEnabled: true,
      isVisible: true,
      providerVisible: true,
      fence,
      turnId: null,
      unloadedTurnRevisions: undefined,
      hostOptionStamp: useStructuredAgentSessionOptionStamp(SESSION, target),
      mutate
    })
  )
  const permission = () => {
    const entry = result.current.optionSnapshot.find(
      (descriptor) => descriptor.id === 'permissionMode'
    )
    return entry?.kind.type === 'select' ? entry.kind.currentValue : null
  }
  await waitFor(() => expect(permission()).toBe('ask'))
  const reads = () =>
    mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length
  const before = reads()
  current.adapter.closeSession.mockClear()
  const otherClient = new RuntimeClientSettingsController(owner)
  await act(async () => {
    await otherClient.update({ nativeChatPermissionMode: 'full-access' })
  })
  await waitFor(() => expect(permission()).toBe('full-access'))
  expect(reads()).toBe(before + 1)
  expect(current.adapter.closeSession).not.toHaveBeenCalled()
  expect(current.adapter.acquire).toHaveBeenCalledTimes(1)
  expect(current.store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
  expect(current.store.getRecord(SESSION)?.options?.permissionMode).toBeUndefined()
  await act(async () => {
    await otherClient.update({ nativeChatPermissionMode: 'ask' })
  })
  await waitFor(() => expect(permission()).toBe('ask'))
  expect(reads()).toBe(before + 2)

  const failure = new Error('chat status read failed')
  const warn = vi.spyOn(current.host.deps.logger, 'warn').mockImplementation(() => {})
  vi.spyOn(current.store, 'getRecord').mockImplementationOnce(() => {
    throw failure
  })
  await expect(
    otherClient.update({ nativeChatPermissionMode: 'full-access' })
  ).resolves.toMatchObject({ nativeChatPermissionMode: 'full-access' })
  expect(owner.getSettings().nativeChatPermissionMode).toBe('full-access')
  expect(warn).toHaveBeenCalledWith(
    'refreshing inherited chat permissions failed',
    expect.objectContaining({ sessionId: SESSION, error: failure })
  )
  await act(async () => {
    current.host.publishInheritedPermissionModes()
  })
  await waitFor(() => expect(permission()).toBe('full-access'))
})
