/**
 * Removing a project on a runtime host (a WSL host, an SSH-managed or paired server) must stop
 * its terminals before `repo.rm`: the host resolves `terminal.stop` through the project's
 * workspace rows, which `repo.rm` deletes, so stopping afterwards left the shells running.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'

const repo: Repo = {
  id: 'app',
  path: '/home/me/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'runtime:wsl%3Aubuntu'
}

const runtimeCall = vi.fn()
const MethodCallSchema = z.object({ method: z.string() })

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  runtimeCall.mockImplementation(async (args: { method: string }) => ({
    id: args.method,
    ok: true,
    result:
      args.method === 'status.get'
        ? {
            runtimeId: 'runtime-1',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          }
        : {},
    _meta: { runtimeId: 'runtime-1' }
  }))
  vi.stubGlobal('window', {
    api: {
      repos: { remove: vi.fn(), removeForHost: vi.fn() },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: runtimeCall },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

describe('project removal on a runtime host', () => {
  it('stops the project’s terminals before the host forgets the project', async () => {
    const store = createTestStore()
    store.setState({
      repos: [repo],
      worktreesByRepo: {
        app: [
          makeWorktree({ id: 'app::/home/me/app', repoId: 'app', hostId: 'runtime:wsl%3Aubuntu' })
        ]
      }
    })

    await store.getState().removeProject('app', { hostId: 'runtime:wsl%3Aubuntu' })

    const methods = runtimeCall.mock.calls
      .map((call: unknown[]) => MethodCallSchema.parse(call[0]).method)
      .filter((method) => method === 'terminal.stop' || method === 'repo.rm')
    expect(methods).toEqual(['terminal.stop', 'repo.rm'])
    expect(store.getState().repos).toEqual([])
  })
})
