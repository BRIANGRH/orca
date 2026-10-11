import { beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

const { handle, fromWebContents } = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents },
  ipcMain: { handle, on: vi.fn(), removeAllListeners: vi.fn(), removeHandler: vi.fn() }
}))
vi.mock('../runtime/rpc/methods', async () => {
  const { defineMethod } = await import('../runtime/rpc/core')
  const { z } = await import('zod')
  return {
    ALL_RPC_METHODS: [
      defineMethod({
        name: 'test.windowOrigin',
        permission: 'workspace',
        params: z.object({ originatingWindowId: z.number().optional() }),
        handler: (_params, context) => ({
          originatingWindowId: context.originatingWindowId,
          caller: context.caller
        })
      })
    ]
  }
})
import { registerRuntimeHandlers } from './runtime'

beforeEach(() => {
  handle.mockReset()
  fromWebContents.mockReset()
})

function register() {
  registerRuntimeHandlers(new OrcaRuntimeService())
  const handler = handle.mock.calls.find(([channel]) => channel === 'runtime:call')?.[1]
  if (!handler) {
    throw new Error('runtime:call was not registered')
  }
  const mainFrame = {}
  const sender = { id: 4, mainFrame, on: vi.fn(), once: vi.fn() }
  return { handler, event: { sender, senderFrame: mainFrame } }
}

it('stamps the actual BrowserWindow id after main-frame validation, ignoring forged params', async () => {
  const { handler, event } = register()
  fromWebContents.mockReturnValue({ id: 17 })
  expect(
    await handler(event, { method: 'test.windowOrigin', params: { originatingWindowId: 999 } })
  ).toMatchObject({ ok: true, result: { originatingWindowId: 17, caller: { kind: 'desktop' } } })
  expect(fromWebContents).toHaveBeenCalledWith(event.sender)
})

it('does not grant window identity when no BrowserWindow owns the sender', async () => {
  const { handler, event } = register()
  fromWebContents.mockReturnValue(null)
  const response = await handler(event, {
    method: 'test.windowOrigin',
    params: { originatingWindowId: 999 }
  })
  expect(response).toMatchObject({ ok: true })
  expect(response.result.originatingWindowId).toBeUndefined()
})

it('rejects a subframe before resolving a window or dispatching a method', async () => {
  const { handler, event } = register()
  await expect(
    handler({ ...event, senderFrame: {} }, { method: 'test.windowOrigin', params: {} })
  ).rejects.toThrow('current main frame')
  expect(fromWebContents).not.toHaveBeenCalled()
})
