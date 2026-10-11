import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { sshArtifactSourceKey } from '../../../../shared/artifact-cli-bridge'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { basename } from '@/lib/path'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { flushPendingEditorChange } from './editor-pending-flush'

export type ShareableFileContentType = ArtifactWriteRequest['contentType']

type ArtifactSourceFile = Pick<
  OpenFile,
  'filePath' | 'externalSshTargetId' | 'runtimeEnvironmentId'
>

/**
 * One published link per file per host, whichever surface shares it: the editor, a rendered
 * preview, or the CLI. SSH keys match the CLI's.
 */
export function fileArtifactSourceKey(
  file: ArtifactSourceFile,
  route: Pick<WorktreeOperationRoute, 'executionHostId' | 'runtimeEnvironmentId'> | null | undefined
): string {
  const host = parseExecutionHostId(route?.executionHostId)
  if (host?.kind === 'ssh') {
    return sshArtifactSourceKey(host.targetId, file.filePath)
  }
  if (file.externalSshTargetId) {
    return sshArtifactSourceKey(file.externalSshTargetId, file.filePath)
  }
  if (route && (route.runtimeEnvironmentId || route.executionHostId !== 'local')) {
    return JSON.stringify([
      'editor',
      route.runtimeEnvironmentId ?? null,
      route.executionHostId,
      file.filePath
    ])
  }
  if (file.runtimeEnvironmentId) {
    return JSON.stringify(['editor', file.runtimeEnvironmentId ?? null, 'remote', file.filePath])
  }
  return file.filePath
}

export function editorArtifactSourceKey(file: OpenFile): string {
  return fileArtifactSourceKey(file, file.operationProvenance?.generation.route)
}

/** What an editor file shares as, or null when it isn't a shareable document. */
export function editorArtifactContentType(
  filePath: string,
  isMarkdown: boolean
): ShareableFileContentType | null {
  if (isMarkdown) {
    return 'text/markdown'
  }
  return isShareableHtmlPath(filePath) ? 'text/html' : null
}

export function isShareableHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

export function createEditorArtifactRequest(
  file: OpenFile,
  content: string,
  contentType: ShareableFileContentType
): ArtifactWriteRequest {
  return {
    sourceKey: editorArtifactSourceKey(file),
    content,
    contentType,
    fileName: basename(file.filePath)
  }
}

export function createCurrentEditorArtifactRequest(
  file: OpenFile,
  contentFileId: string,
  fallbackContent: string,
  contentType: ShareableFileContentType
): ArtifactWriteRequest {
  flushPendingEditorChange(contentFileId)
  const content = useAppStore.getState().editorDrafts[contentFileId] ?? fallbackContent
  return createEditorArtifactRequest(file, content, contentType)
}
