// Share on a chat visual: the page is an ordinary workspace file, so it publishes under the same
// key as that file's editor tab or preview, and sharing from any of them updates one link.

import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'
import { basename } from '@/lib/path'
import {
  readNativeChatVisualFile,
  type NativeChatVisualDocument,
  type NativeChatVisualFile
} from './native-chat-visual-file'

export function nativeChatVisualArtifactSourceKey(file: NativeChatVisualFile): string {
  return fileArtifactSourceKey(file.owner, file.absolutePath)
}

/** One fresh read at the click: the frame shows and Share publishes the same page. */
export async function readNativeChatVisualArtifactRequest(
  file: NativeChatVisualFile,
  showDocument: (document: NativeChatVisualDocument) => void
): Promise<ArtifactWriteRequest> {
  const outcome = await readNativeChatVisualFile(file, { fresh: true })
  if (outcome.kind !== 'ready') {
    throw new ArtifactPublishPreparationError('unreadable')
  }
  showDocument(outcome.document)
  return {
    sourceKey: nativeChatVisualArtifactSourceKey(file),
    content: outcome.document.html,
    contentType: 'text/html',
    fileName: basename(file.absolutePath)
  }
}
