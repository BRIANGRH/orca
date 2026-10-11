import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import { docPreviewArtifactSourceKey } from '@/components/browser-pane/workspace-doc/doc-preview-artifact-share'
import {
  nativeChatVisualArtifactSourceKey,
  readNativeChatVisualArtifactRequest
} from './native-chat-visual-share'
import type { NativeChatVisualIdentity } from './native-chat-visual-read-client'

const mocks = vi.hoisted(() => {
  const state: {
    route: { executionHostId: string; runtimeEnvironmentId: string | null } | null
    read: ReturnType<typeof vi.fn>
  } = { route: null, read: vi.fn() }
  return state
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRoute: () => mocks.route
}))
vi.mock('./native-chat-visual-read-client', () => ({
  readNativeChatVisual: mocks.read
}))

const IDENTITY: NativeChatVisualIdentity = {
  target: { kind: 'local' },
  sessionId: 'session-alpha',
  path: 'reports/latency.html',
  legacy: false
}

beforeEach(() => {
  mocks.route = { executionHostId: 'local', runtimeEnvironmentId: null }
  mocks.read.mockReset()
})

describe('sharing a chat visual', () => {
  it("keys a local page by its absolute path, like the file's browser tab", () => {
    expect(
      nativeChatVisualArtifactSourceKey('reports/latency.html', {
        worktreeId: 'repo::/srv/repo',
        worktreePath: '/srv/repo',
        runtimeEnvironmentId: null
      })
    ).toBe('/srv/repo/reports/latency.html')
  })

  it('keys a page on a paired host exactly as the file preview does', () => {
    mocks.route = { executionHostId: 'runtime:server-1', runtimeEnvironmentId: 'server-1' }
    expect(
      nativeChatVisualArtifactSourceKey('reports/latency.html', {
        worktreeId: 'repo::/srv/repo',
        worktreePath: '/srv/repo',
        runtimeEnvironmentId: 'server-1'
      })
    ).toBe(
      docPreviewArtifactSourceKey({
        filePath: '/srv/repo/reports/latency.html',
        relativePath: 'reports/latency.html',
        worktreeId: 'repo::/srv/repo',
        runtimeEnvironmentId: 'server-1',
        externalSshTargetId: null
      })
    )
  })

  it("publishes the page as the chat's host reads it now", async () => {
    mocks.read.mockResolvedValue({ ok: true, document: { revision: 'r2', html: '<p>new</p>' } })
    await expect(readNativeChatVisualArtifactRequest(IDENTITY, 'key')).resolves.toEqual({
      sourceKey: 'key',
      content: '<p>new</p>',
      contentType: 'text/html',
      fileName: 'latency.html'
    })
    expect(mocks.read).toHaveBeenCalledWith(IDENTITY)
  })

  it('reports a page the host can no longer read as unreadable', async () => {
    mocks.read.mockResolvedValue({ ok: false, reason: 'not_found' })
    await expect(readNativeChatVisualArtifactRequest(IDENTITY, 'key')).rejects.toEqual(
      new ArtifactPublishPreparationError('unreadable')
    )
  })
})
