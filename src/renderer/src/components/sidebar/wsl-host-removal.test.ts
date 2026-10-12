import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  warning: vi.fn(),
  setRuntimeEnvironments: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setRuntimeEnvironments: mocks.setRuntimeEnvironments }) }
}))

import { removeWslHost } from './wsl-host-removal'

function stubApi(result: unknown): ReturnType<typeof vi.fn> {
  const remove = vi.fn(async () => result)
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { list: async () => [], wslHosts: { remove } } }
  })
  return remove
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('removeWslHost', () => {
  beforeEach(() => {
    mocks.warning.mockReset()
    mocks.setRuntimeEnvironments.mockReset()
  })

  it('removes quietly when the server, its daemon and terminals all ended', async () => {
    const remove = stubApi({ stopped: true })
    await removeWslHost('wsl:ubuntu')
    expect(remove).toHaveBeenCalledWith({ environmentId: 'wsl:ubuntu' })
    expect(mocks.setRuntimeEnvironments).toHaveBeenCalledWith([])
    expect(mocks.warning).not.toHaveBeenCalled()
  })

  it('says what is still running in the distro', async () => {
    stubApi({ stopped: false, reason: '1 terminal kept running, so Orca left the server running.' })
    await removeWslHost('wsl:ubuntu')
    expect(mocks.warning).toHaveBeenCalledWith(
      'The host was removed, but something in the distro is still running: 1 terminal kept running, so Orca left the server running.'
    )
  })
})
