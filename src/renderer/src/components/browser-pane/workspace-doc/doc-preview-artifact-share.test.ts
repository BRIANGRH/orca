import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import {
  docPreviewArtifactSourceKey,
  readDocPreviewArtifactRequest
} from './doc-preview-artifact-share'
import type { DocPreviewDocument } from './doc-preview-document-actions'

const mocks = vi.hoisted(() => {
  const state: {
    route: {
      executionHostId: string
      runtimeEnvironmentId: string | null
    } | null
    target: { kind: string; environmentId: string } | null
    read: ReturnType<typeof vi.fn>
  } = { route: null, target: null, read: vi.fn() }
  return state
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRoute: () => mocks.route
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => mocks.target
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => null
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: mocks.read
}))

function previewDocument(overrides: Partial<DocPreviewDocument> = {}): DocPreviewDocument {
  return {
    filePath: '/srv/repo/reports/latency.html',
    relativePath: 'reports/latency.html',
    worktreeId: 'repo::/srv/repo',
    runtimeEnvironmentId: 'server-1',
    externalSshTargetId: null,
    ...overrides
  }
}

beforeEach(() => {
  mocks.route = {
    executionHostId: 'runtime:server-1',
    runtimeEnvironmentId: 'server-1'
  }
  mocks.target = { kind: 'environment', environmentId: 'server-1' }
  mocks.read.mockReset()
})

describe('document preview sharing', () => {
  it('keys a remote HTML file by its owning host, like its editor tab', () => {
    expect(JSON.parse(docPreviewArtifactSourceKey(previewDocument()) ?? 'null')).toEqual([
      'editor',
      'server-1',
      'runtime:server-1',
      '/srv/repo/reports/latency.html'
    ])
  })

  it('offers no share for documents that are not HTML', () => {
    expect(
      docPreviewArtifactSourceKey(previewDocument({ filePath: '/srv/repo/report.pdf' }))
    ).toBeNull()
  })

  it('reads the page from its owning host', async () => {
    mocks.read.mockResolvedValue({
      content: '<h1>Latency</h1>',
      isBinary: false
    })

    await expect(readDocPreviewArtifactRequest(previewDocument(), 'key-1')).resolves.toEqual({
      sourceKey: 'key-1',
      content: '<h1>Latency</h1>',
      contentType: 'text/html',
      fileName: 'latency.html'
    })
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        target: mocks.target,
        relativePath: 'reports/latency.html',
        worktreeId: 'repo::/srv/repo'
      })
    )
  })

  it('reports an unreadable page instead of sharing nothing', async () => {
    mocks.read.mockRejectedValue(new Error('offline'))
    await expect(readDocPreviewArtifactRequest(previewDocument(), 'key-1')).rejects.toEqual(
      new ArtifactPublishPreparationError('unreadable')
    )

    mocks.target = null
    await expect(readDocPreviewArtifactRequest(previewDocument(), 'key-1')).rejects.toEqual(
      new ArtifactPublishPreparationError('unreadable')
    )
  })
})
