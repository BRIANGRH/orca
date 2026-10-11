// Share on a chat visual: the page is an ordinary workspace file, so it publishes under the same
// key as that file's editor tab or preview, and sharing from any of them updates one link.

import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import { fileArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import { resolveExplicitFileLinkTargetPath } from '@/lib/explicit-file-link-target'
import { basename } from '@/lib/path'
import { resolveWorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { useAppStore } from '@/store'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  readNativeChatVisual,
  type NativeChatVisualIdentity
} from './native-chat-visual-read-client'

export function nativeChatVisualArtifactSourceKey(
  path: string,
  context: NativeChatFileLinkContext
): string | null {
  const filePath = resolveExplicitFileLinkTargetPath(path, context.worktreePath)
  if (!filePath) {
    return null
  }
  return fileArtifactSourceKey(
    { filePath, runtimeEnvironmentId: context.runtimeEnvironmentId },
    resolveWorktreeOperationRoute(useAppStore.getState(), context.worktreeId)
  )
}

/** Re-reads through the chat's host, so Share publishes the file as it is now. */
export async function readNativeChatVisualArtifactRequest(
  identity: NativeChatVisualIdentity,
  sourceKey: string
): Promise<ArtifactWriteRequest> {
  const outcome = await readNativeChatVisual(identity)
  if (!outcome.ok) {
    throw new ArtifactPublishPreparationError('unreadable')
  }
  return {
    sourceKey,
    content: outcome.document.html,
    contentType: 'text/html',
    fileName: basename(identity.path)
  }
}
