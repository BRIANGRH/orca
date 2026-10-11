import type { ArtifactWriteRequest } from '../../../../../shared/artifacts'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import type { BrowserChromeShareControl } from '@/components/browser-pane/assemble-chrome/browser-chrome-toolbar'
import {
  fileArtifactSourceKey,
  isShareableHtmlPath
} from '@/components/editor/editor-artifact-upload'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { basename } from '@/lib/path'
import { resolveWorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import type { DocPreviewDocument } from './doc-preview-document-actions'

/** Null for documents a share link can't render (only HTML previews are shared from here). */
export function docPreviewArtifactSourceKey(document: DocPreviewDocument): string | null {
  if (!isShareableHtmlPath(document.filePath)) {
    return null
  }
  return fileArtifactSourceKey(
    {
      filePath: document.filePath,
      runtimeEnvironmentId: document.runtimeEnvironmentId,
      ...(document.externalSshTargetId ? { externalSshTargetId: document.externalSshTargetId } : {})
    },
    resolveWorktreeOperationRoute(useAppStore.getState(), document.worktreeId)
  )
}

/** Reads the document from the host that owns it, the same way its source tab does. */
export async function readDocPreviewArtifactRequest(
  document: DocPreviewDocument,
  sourceKey: string
): Promise<ArtifactWriteRequest> {
  const state = useAppStore.getState()
  const target = getRuntimeTargetForFileOwner(
    state,
    document.worktreeId,
    document.runtimeEnvironmentId
  )
  if (!target) {
    throw new ArtifactPublishPreparationError('unreadable')
  }
  let result: Awaited<ReturnType<typeof readRuntimeFileContent>>
  try {
    result = await readRuntimeFileContent({
      target,
      filePath: document.filePath,
      relativePath: document.relativePath,
      worktreeId: document.worktreeId,
      connectionId: getConnectionIdForFile(document.worktreeId, document.filePath) ?? undefined,
      expectedExternalSshTargetId: document.externalSshTargetId ?? undefined
    })
  } catch {
    throw new ArtifactPublishPreparationError('unreadable')
  }
  if (result.isBinary) {
    throw new ArtifactPublishPreparationError('binary')
  }
  return {
    sourceKey,
    content: result.content,
    contentType: 'text/html',
    fileName: basename(document.filePath)
  }
}

/** The toolbar's Share button for an HTML preview; undefined for anything else. */
export function buildDocPreviewShareControl(
  document: DocPreviewDocument
): ((control: BrowserChromeShareControl) => React.ReactNode) | undefined {
  const sourceKey = docPreviewArtifactSourceKey(document)
  if (!sourceKey) {
    return undefined
  }
  return (control) => (
    <ArtifactPublishButton
      sourceKey={sourceKey}
      className="h-7 w-7"
      createRequest={() => readDocPreviewArtifactRequest(document, sourceKey)}
      {...control}
    />
  )
}
