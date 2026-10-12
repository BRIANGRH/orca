import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import { editorArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import {
  browserTabKey,
  editorTab,
  localRoute,
  pairedOwner,
  pairedRoute,
  previewKey
} from '@/lib/file-artifact-source-key.test-support'

const mocks = vi.hoisted(() => {
  const state: { environmentId: string | null; read: ReturnType<typeof vi.fn> } = {
    environmentId: null,
    read: vi.fn()
  }
  return state
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ editorDrafts: {} }) } }))
vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFilePreview: mocks.read }))
vi.mock('@/components/terminal-pane/terminal-file-path-mapping', () => ({
  getTerminalFileContext: (worktreeId: string, worktreePath: string) => ({
    target: mocks.environmentId
      ? { kind: 'environment', environmentId: mocks.environmentId }
      : { kind: 'local' },
    worktreeId,
    worktreePath,
    sourceHostResolved: true
  })
}))
vi.mock('@/components/terminal-pane/terminal-worktree-path-link', () => ({
  terminalFileSourceHost: () => (mocks.environmentId ? `runtime:${mocks.environmentId}` : 'local')
}))

import {
  clearNativeChatVisualFileCacheForTests,
  readNativeChatVisualFile,
  resolveNativeChatVisualFile,
  type NativeChatVisualFile
} from './native-chat-visual-file'
import {
  nativeChatVisualArtifactSourceKey,
  readNativeChatVisualArtifactRequest
} from './native-chat-visual-share'

const PATH = 'reports/latency.html'

function chatVisual(worktreePath: string, environmentId: string | null): NativeChatVisualFile {
  mocks.environmentId = environmentId
  const file = resolveNativeChatVisualFile(
    { worktreeId: 'repo::/srv/repo', worktreePath, runtimeEnvironmentId: environmentId },
    PATH
  )
  if (!file) {
    throw new Error('unresolved')
  }
  return file
}

function chatKey(worktreePath: string, environmentId: string | null): string {
  return nativeChatVisualArtifactSourceKey(chatVisual(worktreePath, environmentId))
}

beforeEach(() => {
  mocks.read.mockReset()
  clearNativeChatVisualFileCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat visual share key', () => {
  it("matches the file's editor tab and browser tab on this machine", async () => {
    const key = chatKey('/srv/repo', null)
    expect(key).toBe('/srv/repo/reports/latency.html')
    expect(editorArtifactSourceKey(editorTab('/srv/repo/reports/latency.html', localRoute))).toBe(
      key
    )
    expect(await browserTabKey('file:///srv/repo/reports/latency.html')).toBe(key)
  })

  it("matches the file's editor tab and preview on a paired host", () => {
    const key = chatKey('/srv/repo', 'server-1')
    expect(previewKey(pairedOwner, '/srv/repo/reports/latency.html')).toBe(key)
    expect(editorArtifactSourceKey(editorTab('/srv/repo/reports/latency.html', pairedRoute))).toBe(
      key
    )
  })

  it('spells a Windows path one way across surfaces, local and paired', async () => {
    const local = chatKey('C:\\repo', null)
    expect(local).toBe('C:\\repo\\reports\\latency.html')
    expect(await browserTabKey('file:///C:/repo/reports/latency.html')).toBe(local)
    expect(editorArtifactSourceKey(editorTab('C:/repo/reports/latency.html', localRoute))).toBe(
      local
    )

    const paired = chatKey('C:\\srv\\repo', 'server-1')
    expect(previewKey(pairedOwner, 'C:\\srv\\repo\\reports\\latency.html')).toBe(paired)
    expect(
      editorArtifactSourceKey(editorTab('C:/srv/repo/reports/latency.html', pairedRoute))
    ).toBe(paired)
  })
})

describe('chat visual share request', () => {
  it('reads the file afresh at the click, not by joining a read already under way', async () => {
    const file = chatVisual('/srv/repo', 'server-1')
    let finishOlder: (value: unknown) => void = () => {}
    mocks.read.mockReturnValueOnce(new Promise((resolve) => (finishOlder = resolve)))
    mocks.read.mockResolvedValueOnce({ content: '<p>saved</p>', isBinary: false })
    const older = readNativeChatVisualFile(file)
    const show = vi.fn()

    await expect(readNativeChatVisualArtifactRequest(file, show)).resolves.toEqual({
      sourceKey: nativeChatVisualArtifactSourceKey(file),
      content: '<p>saved</p>',
      contentType: 'text/html',
      fileName: 'latency.html'
    })
    expect(show).toHaveBeenCalledWith({ html: '<p>saved</p>' })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    finishOlder({ content: '<p>old</p>', isBinary: false })
    await older
  })

  it.each([
    ['unreachable', new Error('Runtime environment is not connected')],
    ['missing', new Error('ENOENT: no such file or directory')]
  ])('reports an %s file as unreadable and shows nothing new', async (_name, error) => {
    mocks.read.mockRejectedValue(error)
    const show = vi.fn()
    await expect(
      readNativeChatVisualArtifactRequest(chatVisual('/srv/repo', null), show)
    ).rejects.toEqual(new ArtifactPublishPreparationError('unreadable'))
    expect(show).not.toHaveBeenCalled()
  })
})
