import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
const owner = vi.hoisted(() => {
  const state: { environmentId: string | null; resolved: boolean } = {
    environmentId: 'env-1',
    resolved: true
  }
  return state
})
vi.mock('@/components/terminal-pane/terminal-file-path-mapping', () => ({
  getTerminalFileContext: (worktreeId: string, worktreePath: string) => ({
    target: owner.environmentId
      ? { kind: 'environment', environmentId: owner.environmentId }
      : { kind: 'local' },
    worktreeId,
    worktreePath,
    sourceHostResolved: owner.resolved
  })
}))
vi.mock('@/components/terminal-pane/terminal-worktree-path-link', () => ({
  terminalFileSourceHost: () => (owner.environmentId ? `runtime:${owner.environmentId}` : null)
}))

import {
  clearNativeChatVisualFileCacheForTests,
  peekNativeChatVisualFile,
  readNativeChatVisualFile,
  resolveNativeChatVisualFile,
  type NativeChatVisualFile
} from './native-chat-visual-file'

const context = {
  worktreeId: 'repo::/srv/app',
  worktreePath: '/srv/app',
  runtimeEnvironmentId: 'env-1'
}

function resolved(path: string): NativeChatVisualFile {
  const file = resolveNativeChatVisualFile(context, path)
  if (!file) {
    throw new Error('unresolved')
  }
  return file
}

beforeEach(() => {
  owner.environmentId = 'env-1'
  owner.resolved = true
  callRuntimeRpc.mockReset()
  clearNativeChatVisualFileCacheForTests()
})

describe('resolveNativeChatVisualFile', () => {
  it("names the paired host that owns the chat's workspace, from one resolution", () => {
    expect(resolveNativeChatVisualFile(context, 'reports/usage.html')).toMatchObject({
      absolutePath: '/srv/app/reports/usage.html',
      fileContext: { target: { kind: 'environment', environmentId: 'env-1' } },
      owner: { executionHostId: 'runtime:env-1', runtimeEnvironmentId: 'env-1' }
    })
  })

  it('names this machine for a local workspace', () => {
    owner.environmentId = null
    expect(
      resolveNativeChatVisualFile({ ...context, runtimeEnvironmentId: null }, 'a.html')?.owner
    ).toEqual({ executionHostId: 'local', runtimeEnvironmentId: null })
  })

  it('resolves nothing when no single owner names the host', () => {
    owner.resolved = false
    expect(resolveNativeChatVisualFile(context, 'a.html')).toBeNull()
  })
})

describe('readNativeChatVisualFile', () => {
  it("reads a paired host's page as a workspace-relative preview, one read for concurrent asks", async () => {
    callRuntimeRpc.mockResolvedValue({ content: '<p>chart</p>', isBinary: false })
    const file = resolved('reports/usage.html')

    const [first, second] = await Promise.all([
      readNativeChatVisualFile(file),
      readNativeChatVisualFile(file)
    ])

    expect(first).toEqual({ kind: 'ready', document: { html: '<p>chart</p>' } })
    expect(second).toBe(first)
    expect(callRuntimeRpc).toHaveBeenCalledOnce()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'files.readPreview',
      { worktree: 'id:repo::/srv/app', relativePath: 'reports/usage.html' },
      expect.anything()
    )
    expect(peekNativeChatVisualFile(file)).toEqual({ html: '<p>chart</p>' })
  })

  it('reads again on every load: the cache only paints a remount', async () => {
    const file = resolved('a.html')
    callRuntimeRpc.mockResolvedValue({ content: '<p>1</p>', isBinary: false })
    await readNativeChatVisualFile(file)
    callRuntimeRpc.mockResolvedValue({ content: '<p>2</p>', isBinary: false })

    expect(await readNativeChatVisualFile(file)).toEqual({
      kind: 'ready',
      document: { html: '<p>2</p>' }
    })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing', new Error('ENOENT: no such file or directory'), 'refused'],
    ['too large', new Error('file_too_large'), 'refused'],
    ['unreachable', new Error('Runtime environment is not connected'), 'unreachable']
  ])('reads a %s page as %s', async (_name, error, kind) => {
    const file = resolved('a.html')
    callRuntimeRpc.mockResolvedValue({ content: '<p>1</p>', isBinary: false })
    await readNativeChatVisualFile(file)
    callRuntimeRpc.mockRejectedValue(error)

    expect(await readNativeChatVisualFile(file)).toEqual({ kind })
    // A refusal says the cached page no longer stands for the file; lost contact says nothing.
    expect(peekNativeChatVisualFile(file) === null).toBe(kind === 'refused')
  })
})
