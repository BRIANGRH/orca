import { describe, expect, it, vi } from 'vitest'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import { stopWslHostServer, type WslHostServerStopSteps } from './wsl-host-server-stop'

function census(liveSessions: number | null): OrcadTerminalCensus {
  return { liveSessions, startedSinceActivation: liveSessions, daemonProtocolVersion: 1 }
}

function steps(overrides: Partial<WslHostServerStopSteps> = {}) {
  const order: string[] = []
  const all = {
    endTerminals: vi.fn(async () => {
      order.push('endTerminals')
    }),
    census: vi.fn(async () => {
      order.push('census')
      return census(0)
    }),
    closeBridge: vi.fn(async () => {
      order.push('closeBridge')
    }),
    decommission: vi.fn(async () => {
      order.push('decommission')
      return {
        outcome: 'decommissioned' as const,
        version: '1.0.0',
        retirement: 'retired' as const
      }
    }),
    sleep: vi.fn(async () => {}),
    ...overrides
  }
  return { all, order }
}

describe('stopWslHostServer', () => {
  it('ends terminals, proves none remain, closes the bridge, then retires orcad and its daemon', async () => {
    const { all, order } = steps()
    await expect(stopWslHostServer(all)).resolves.toEqual({ stopped: true })
    expect(order).toEqual(['endTerminals', 'census', 'closeBridge', 'decommission'])
    expect(all.decommission).toHaveBeenCalledWith(census(0))
  })

  it('waits for shells to exit before asking the daemon to retire', async () => {
    const counts = [census(2), census(1), census(0)]
    const { all } = steps({ census: vi.fn(async () => counts.shift() ?? census(0)) })
    await expect(stopWslHostServer(all)).resolves.toEqual({ stopped: true })
    expect(all.census).toHaveBeenCalledTimes(3)
  })

  it('leaves the server running and says why when terminals remain or cannot be counted', async () => {
    const live = steps({ census: vi.fn(async () => census(1)) })
    await expect(stopWslHostServer(live.all)).resolves.toEqual({
      stopped: false,
      reason: '1 terminal kept running, so Orca left the server running.'
    })
    expect(live.all.decommission).not.toHaveBeenCalled()
    expect(live.all.closeBridge).toHaveBeenCalled()

    const unknown = steps({ census: vi.fn(async () => census(null)) })
    await expect(stopWslHostServer(unknown.all)).resolves.toMatchObject({ stopped: false })
  })

  it('reports a daemon that did not retire', async () => {
    const { all } = steps({
      decommission: vi.fn(async () => ({
        outcome: 'decommissioned' as const,
        version: '1.0.0',
        retirement: 'live' as const
      }))
    })
    await expect(stopWslHostServer(all)).resolves.toEqual({
      stopped: false,
      reason: 'Orca’s server stopped, but its terminal daemon is still running.'
    })
  })
})
