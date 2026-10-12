import { describe, expect, it, vi } from 'vitest'
import { editorArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import { canonicalArtifactFilePath } from './file-artifact-source-key'
import {
  browserTabKey,
  editorTab,
  localRoute,
  pairedOwner,
  pairedRoute,
  previewKey,
  type Route
} from './file-artifact-source-key.test-support'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ editorDrafts: {} }) } }))

describe('file artifact source key', () => {
  it('gives a local file one key from the editor and a browser tab, whatever its slashes', async () => {
    const key = await browserTabKey('file:///C:/repo/report.html')
    expect(key).toBe('C:\\repo\\report.html')
    expect(editorArtifactSourceKey(editorTab('C:/repo/report.html', localRoute))).toBe(key)
    expect(editorArtifactSourceKey(editorTab('C:\\repo\\report.html', localRoute))).toBe(key)
    expect(await browserTabKey('file:///tmp/report.html')).toBe(
      editorArtifactSourceKey(editorTab('/tmp/report.html', localRoute))
    )
  })

  it('gives a paired-server file one key from the editor and the rendered preview', () => {
    const key = editorArtifactSourceKey(editorTab('/srv/repo/report.html', pairedRoute))
    expect(JSON.parse(key)).toEqual([
      'editor',
      'server-1',
      'runtime:server-1',
      '/srv/repo/report.html'
    ])
    expect(previewKey(pairedOwner, '/srv/repo/report.html')).toBe(key)
  })

  it('spells a paired Windows server path one way across surfaces', () => {
    expect(previewKey(pairedOwner, 'C:\\srv\\repo\\report.html')).toBe(
      editorArtifactSourceKey(editorTab('C:/srv/repo/report.html', pairedRoute))
    )
  })

  it('matches the CLI key for SSH files from the editor and the preview', () => {
    const route: Route = { executionHostId: 'ssh:build-box', runtimeEnvironmentId: null }
    const key = editorArtifactSourceKey(editorTab('/home/me/report.html', route))
    expect(JSON.parse(key)).toEqual(['ssh', 'build-box', '/home/me/report.html'])
    expect(previewKey({ kind: 'ssh', connectionId: 'build-box' }, '/home/me/report.html')).toBe(key)
  })

  it('keeps the remote fallback for editor tabs opened before routes were recorded', () => {
    const tab = { ...editorTab('/srv/repo/report.html', null), runtimeEnvironmentId: 'server-1' }
    expect(JSON.parse(editorArtifactSourceKey(tab))).toEqual([
      'editor',
      'server-1',
      'remote',
      '/srv/repo/report.html'
    ])
  })

  it('leaves POSIX paths alone and canonicalizes drive and UNC paths', () => {
    expect(canonicalArtifactFilePath('/srv/repo/a.html')).toBe('/srv/repo/a.html')
    expect(canonicalArtifactFilePath('C:/repo/a.html')).toBe('C:\\repo\\a.html')
    expect(canonicalArtifactFilePath('//server/share/a.html')).toBe('\\\\server\\share\\a.html')
  })
})
