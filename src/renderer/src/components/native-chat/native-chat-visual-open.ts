// "Open in new tab" on a chat visual: the page is an ordinary workspace file, so it opens exactly
// as a click on a link to that file in the same chat would.

import { resolveExplicitFileLinkTargetPath } from '@/lib/explicit-file-link-target'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  showFileLinkNotFoundToast,
  showFileLinkUnresolvedToast,
  showFileLinkUnverifiableToast
} from './native-chat-file-link-toasts'

export function openNativeChatVisualFile(path: string, context: NativeChatFileLinkContext): void {
  const absolutePath = resolveExplicitFileLinkTargetPath(path, context.worktreePath)
  if (!absolutePath) {
    showFileLinkUnresolvedToast(path)
    return
  }
  openDetectedFilePath(absolutePath, null, null, {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    runtimeEnvironmentId: context.runtimeEnvironmentId,
    onOpenFailure: (failure) =>
      failure.verdict === 'unverifiable'
        ? showFileLinkUnverifiableToast(absolutePath, failure.error)
        : showFileLinkNotFoundToast(absolutePath)
  })
}
