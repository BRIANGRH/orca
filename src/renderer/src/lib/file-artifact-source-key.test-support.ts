// The keys each Share surface publishes a file under, for checking they agree.

import { expect, vi } from 'vitest'
import type { DocPreviewGrantOwner } from '../../../preload/api/doc-preview-api'
import type { OpenFile } from '@/store/slices/editor'
import {
  getShareableBrowserArtifactFile,
  readBrowserHtmlArtifactRequest
} from '@/components/browser-pane/describe-page/browser-artifact-upload'
import { docPreviewGrantFileOwner } from '@/components/browser-pane/workspace-doc/doc-preview-artifact-share'
import { fileArtifactSourceKey } from './file-artifact-source-key'

export type Route = {
  executionHostId: 'local' | `runtime:${string}` | `ssh:${string}`
  runtimeEnvironmentId: string | null
}

export function editorTab(filePath: string, route: Route | null): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: 'report.html',
    worktreeId: 'repo::/srv/repo',
    language: 'html',
    isDirty: false,
    mode: 'edit',
    runtimeEnvironmentId: route?.runtimeEnvironmentId ?? undefined,
    ...(route
      ? {
          operationProvenance: {
            ownershipProjection: 'explicit',
            generation: {
              route,
              runtimeConnectionGeneration: 1,
              runtimePairingRevision: 1,
              runtimeSshGeneration: null,
              nestedSshGeneration: null,
              directSshGeneration: null
            }
          }
        }
      : {})
  }
}

/** The key a browser tab publishes under, checked against the one its Share button looks up. */
export async function browserTabKey(url: string): Promise<string> {
  vi.stubGlobal('window', {
    api: {
      fs: {
        stat: () => Promise.resolve({ size: 1, isDirectory: false }),
        readFile: () => Promise.resolve({ content: '<p>x</p>', isBinary: false })
      }
    }
  })
  const { sourceKey } = await readBrowserHtmlArtifactRequest(url)
  expect(getShareableBrowserArtifactFile(url)?.filePath).toBe(sourceKey)
  return sourceKey
}

export function previewKey(owner: DocPreviewGrantOwner, filePath: string): string {
  return fileArtifactSourceKey(docPreviewGrantFileOwner(owner), filePath)
}

export const pairedOwner: DocPreviewGrantOwner = {
  kind: 'runtime',
  environmentId: 'server-1',
  worktreeSelector: 'id:repo::/srv/repo',
  worktreeRoot: '/srv/repo'
}
export const pairedRoute: Route = {
  executionHostId: 'runtime:server-1',
  runtimeEnvironmentId: 'server-1'
}
export const localRoute: Route = { executionHostId: 'local', runtimeEnvironmentId: null }
