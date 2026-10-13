import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

describe('an old chat inheriting its host permission setting', () => {
  it('publishes changes without persisting them or restarting a busy child, then replaces it once idle', async () => {
    let setting: AgentChatPermissionMode = 'ask'
    const current = await createRestTestRig({ newChatPermissionMode: () => setting })
    rig = current
    await foundRestTestChat(current)
    const fence = () => current.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    const before = current.host.readStatusSummary(SESSION)
    expect(before?.permissionMode).toBe('ask')
    current.statusEvents.length = 0
    current.adapter.closeSession.mockClear()
    current.adapter.holdsDispatch.mockReturnValue(true)
    setting = 'full-access'
    current.host.publishInheritedPermissionModes()
    const after = current.host.readStatusSummary(SESSION)
    expect(`${after?.model ?? ''}|${after?.permissionMode ?? ''}`).not.toBe(
      `${before?.model ?? ''}|${before?.permissionMode ?? ''}`
    )
    expect(after).toEqual({ ...before, permissionMode: 'full-access' })
    expect(current.statusEvents).toEqual([{ type: 'status', session: after }])
    expect(current.store.getRecord(SESSION)?.options?.permissionMode).toBeUndefined()
    expect(current.adapter.closeSession).not.toHaveBeenCalled()
    expect((await current.host.readOptions(SESSION)).current.permissionMode).toBe('full-access')

    expect((await current.host.send(CALLER, restTestSend('while replying', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(current.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(current.adapter.acquire).toHaveBeenCalledTimes(1)
    expect(current.adapter.closeSession).not.toHaveBeenCalled()
    current.adapter.holdsDispatch.mockReturnValue(false)
    expect((await current.host.send(CALLER, restTestSend('after replying', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(current.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(current.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(current.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'full-access' })
    )
    expect((await current.host.send(CALLER, restTestSend('reuse', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(current.adapter.dispatch).toHaveBeenCalledTimes(4))
    expect(current.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(current.store.getRecord(SESSION)?.options?.permissionMode).toBeUndefined()
    current.statusEvents.length = 0
    current.host.publishInheritedPermissionModes()
    expect(current.statusEvents).toEqual([])
  })

  it('saves the current inherited Ask choice and keeps it when the default becomes Full access', async () => {
    let setting: AgentChatPermissionMode = 'ask'
    const current = await createRestTestRig({ newChatPermissionMode: () => setting })
    rig = current
    await foundRestTestChat(current)
    const fence = () => current.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    const fields = { key: 'permissionMode', value: 'ask' }
    expect(
      (
        await current.host.setOption(CALLER, {
          ...fields,
          envelope: {
            sessionId: SESSION,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: fence(),
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.setOption',
              sessionId: SESSION,
              fields
            })
          }
        })
      ).ok
    ).toBe(true)
    const before = current.host.readStatusSummary(SESSION)
    expect(before?.permissionMode).toBe('ask')
    current.statusEvents.length = 0
    setting = 'full-access'
    current.host.publishInheritedPermissionModes()
    expect(current.statusEvents).toEqual([])
    expect(current.host.readStatusSummary(SESSION)).toEqual(before)
    expect((await current.host.send(CALLER, restTestSend('explicit Ask', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(current.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(current.adapter.acquire).toHaveBeenCalledTimes(1)
    expect(current.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'ask' })
    )
  })

  it('publishes the agent-supported default intent while options retain their safety narrowing', async () => {
    let setting: unknown = 'full-access'
    const current = await createRestTestRig({ newChatPermissionMode: () => setting })
    rig = current
    await foundRestTestChat(current)
    setting = 'accept-edits'
    current.host.publishInheritedPermissionModes()
    expect(current.host.readStatusSummary(SESSION)?.permissionMode).toBe('ask')
    expect((await current.host.readOptions(SESSION)).current.permissionMode).toBe('ask')
    setting = 'invalid'
    current.host.publishInheritedPermissionModes()
    expect(current.host.readStatusSummary(SESSION)?.permissionMode).toBe('ask')
  })
})
