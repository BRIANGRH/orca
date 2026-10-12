// A chat visual is an ordinary file the chat links to: resolved through the chat's file-link
// context and read the way a file preview reads it, on the workspace's own host.
//
// The cache only paints a remounted visual without a flash: every load still reads the file.

import { resolveExplicitFileLinkTargetPath } from '@/lib/explicit-file-link-target'
import { chatHtmlAccess } from '@/lib/local-file-access'
import { useAppStore } from '@/store'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-client'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  getTerminalFileContext,
  type TerminalFileContext
} from '@/components/terminal-pane/terminal-file-path-mapping'
import { terminalFileSourceHost } from '@/components/terminal-pane/terminal-worktree-path-link'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../../../shared/native-chat-visual-directive'
import type { NativeChatFileLinkContext } from './native-chat-file-link'

export type NativeChatVisualFile = {
  absolutePath: string
  fileContext: TerminalFileContext
  /** The host that serves the file, from the same resolution as `fileContext`. */
  owner: { executionHostId: ExecutionHostId; runtimeEnvironmentId: string | null }
}

export type NativeChatVisualDocument = { html: string }

/**
 * `refused`: the host answered that the file can't be shown (missing, binary, too large).
 * `unreachable`: no answer, which says nothing about the file.
 */
export type NativeChatVisualReadOutcome =
  | { kind: 'ready'; document: NativeChatVisualDocument }
  | { kind: 'refused' }
  | { kind: 'unreachable' }

const MAX_CACHED_DOCUMENTS = 24
const MAX_CACHED_CHARS = 6 * 1024 * 1024

const cache = new Map<string, NativeChatVisualDocument>()
const inFlight = new Map<string, Promise<NativeChatVisualReadOutcome>>()

/** Null when no single owner names the workspace's host: the visual is unavailable, never read locally. */
export function resolveNativeChatVisualFile(
  context: NativeChatFileLinkContext,
  path: string
): NativeChatVisualFile | null {
  const absolutePath = resolveExplicitFileLinkTargetPath(path, context.worktreePath)
  if (!absolutePath) {
    return null
  }
  const fileContext = getTerminalFileContext(
    context.worktreeId,
    context.worktreePath,
    context.runtimeEnvironmentId
  )
  if (!fileContext.sourceHostResolved) {
    return null
  }
  return {
    absolutePath,
    fileContext,
    owner: {
      // Why local on no route: a resolved context without a source host is this machine's file.
      executionHostId:
        terminalFileSourceHost(useAppStore.getState(), fileContext) ?? LOCAL_EXECUTION_HOST_ID,
      runtimeEnvironmentId: runtimeTargetEnvironmentId(fileContext.target)
    }
  }
}

function cacheKey(file: NativeChatVisualFile): string {
  return JSON.stringify([
    file.owner.executionHostId,
    file.owner.runtimeEnvironmentId,
    file.fileContext.connectionId ?? null,
    file.absolutePath
  ])
}

export function peekNativeChatVisualFile(
  file: NativeChatVisualFile
): NativeChatVisualDocument | null {
  return cache.get(cacheKey(file)) ?? null
}

function remember(key: string, document: NativeChatVisualDocument): void {
  cache.delete(key)
  cache.set(key, document)
  let chars = 0
  for (const entry of cache.values()) {
    chars += entry.html.length
  }
  for (const [oldestKey, oldest] of cache) {
    if (cache.size <= MAX_CACHED_DOCUMENTS && chars <= MAX_CACHED_CHARS) {
      break
    }
    cache.delete(oldestKey)
    chars -= oldest.html.length
  }
}

async function readOnce(
  key: string,
  file: NativeChatVisualFile
): Promise<NativeChatVisualReadOutcome> {
  try {
    const result = await readRuntimeFilePreview(
      file.fileContext,
      file.absolutePath,
      chatHtmlAccess()
    )
    if (
      result.isBinary ||
      new TextEncoder().encode(result.content).byteLength > NATIVE_CHAT_VISUAL_MAX_BYTES
    ) {
      cache.delete(key)
      return { kind: 'refused' }
    }
    const document = { html: result.content }
    remember(key, document)
    return { kind: 'ready', document }
  } catch (error) {
    // Why only these: a paired host answers `file_too_large` past 512 KiB; anything else may be transport.
    if (
      isMissingRuntimePathError(error) ||
      (error instanceof Error && error.message === 'file_too_large')
    ) {
      cache.delete(key)
      return { kind: 'refused' }
    }
    return { kind: 'unreachable' }
  }
}

/** Reads the file now; visuals of the same file asking at once share one read. */
export function readNativeChatVisualFile(
  file: NativeChatVisualFile
): Promise<NativeChatVisualReadOutcome> {
  const key = cacheKey(file)
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const read = readOnce(key, file).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, read)
  return read
}

export function clearNativeChatVisualFileCacheForTests(): void {
  cache.clear()
  inFlight.clear()
}
