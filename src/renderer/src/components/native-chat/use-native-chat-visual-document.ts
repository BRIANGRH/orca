import { useEffect, useState } from 'react'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'
import {
  peekNativeChatVisualFile,
  readNativeChatVisualFile,
  type NativeChatVisualDocument,
  type NativeChatVisualFile
} from './native-chat-visual-file'

export type NativeChatVisualDocumentState =
  | { status: 'loading' }
  | { status: 'ready'; document: NativeChatVisualDocument }
  | { status: 'unavailable' }

const FILE_CHANGE_DEBOUNCE_MS = 125

/** Whether a watcher batch another view's watch produced names this file (or may have: an overflow). */
export function fileChangeNamesVisual(
  detail: WorktreeFileChangeEventDetail,
  file: Pick<NativeChatVisualFile, 'absolutePath' | 'owner'>
): boolean {
  if (detail.runtimeEnvironmentId !== file.owner.runtimeEnvironmentId) {
    return false
  }
  const payload: FsChangedPayload = detail.payload
  const target = normalizeRuntimePathForComparison(file.absolutePath)
  return payload.events.some((event) =>
    event.kind === 'overflow'
      ? isPathInsideOrEqual(payload.worktreePath, file.absolutePath)
      : [event.absolutePath, event.oldAbsolutePath].some(
          (path) => path !== undefined && normalizeRuntimePathForComparison(path) === target
        )
  )
}

/** Bumps when a watch someone else installed reports this file changed; installs no watch itself. */
function useVisualFileChangeCount(file: NativeChatVisualFile | null, enabled: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!file || !enabled) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]): void => {
      if (!fileChangeNamesVisual(event.detail, file)) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => setCount((value) => value + 1), FILE_CHANGE_DEBOUNCE_MS)
    }
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, onChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, onChange)
    }
  }, [enabled, file])
  return count
}

/**
 * The visual's current page. Starts from the cached copy when there is one, reads the file once
 * `enabled`, and again whenever `refreshKey` changes or the file changes under a watch. An
 * unchanged page keeps its frame; an unreachable host keeps the page already shown.
 */
export function useNativeChatVisualDocument(
  file: NativeChatVisualFile | null,
  enabled: boolean,
  refreshKey: unknown
): NativeChatVisualDocumentState {
  const [state, setState] = useState<NativeChatVisualDocumentState>(() => {
    const cached = file ? peekNativeChatVisualFile(file) : null
    return cached ? { status: 'ready', document: cached } : { status: 'loading' }
  })
  const changes = useVisualFileChangeCount(file, enabled)

  useEffect(() => {
    if (!enabled) {
      return
    }
    if (!file) {
      setState({ status: 'unavailable' })
      return
    }
    let current = true
    void readNativeChatVisualFile(file).then((outcome) => {
      if (!current) {
        return
      }
      setState((shown) => {
        if (outcome.kind === 'ready') {
          return shown.status === 'ready' && shown.document.html === outcome.document.html
            ? shown
            : { status: 'ready', document: outcome.document }
        }
        return outcome.kind === 'unreachable' && shown.status === 'ready'
          ? shown
          : { status: 'unavailable' }
      })
    })
    return () => {
      current = false
    }
  }, [enabled, file, refreshKey, changes])

  return state
}
