// Reading one visual out of a chat's folder (its worktree, folder workspace or pinned floating
// folder). This is the boundary, not the renderer: the page must resolve, canonically, inside that
// folder, be a regular file, and be UTF-8 text within the byte cap. Symlinks inside the folder are
// followed like any workspace file; one that leads out of it is refused.

import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  NATIVE_CHAT_VISUAL_MAX_BYTES,
  isNativeChatVisualPath
} from '../../shared/native-chat-visual-directive'
import type {
  AgentSessionReadVisualResult,
  AgentSessionVisualReadError
} from '../../shared/rpc-contract/agent-session-visual-params'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { readLocalFileBounded } from '../ipc/filesystem/local-regular-file-read'

// Why O_NOFOLLOW on the resolved path: a final component swapped for a symlink after the realpath
// fails the open instead of redirecting it. Windows has no such flag; the post-open identity check
// holds the line there.
const VISUAL_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)

const REVISION_HEX_LENGTH = 32

class VisualReadRefusal extends Error {
  constructor(readonly refusal: AgentSessionVisualReadError) {
    super(refusal)
  }
}

function refuse(refusal: AgentSessionVisualReadError): never {
  throw new VisualReadRefusal(refusal)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function isAbsence(error: unknown): boolean {
  return isENOENT(error) || errorCode(error) === 'ENOTDIR'
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isAbsence(error)) {
      refuse('not_found')
    }
    throw error
  }
}

/** The page's canonical path, refused unless it lies strictly inside the canonical folder. */
async function containedPage(folder: string, path: string): Promise<string> {
  const folderReal = await canonical(folder)
  const page = await canonical(join(folderReal, ...path.split('/')))
  if (page === folderReal || !isPathInsideOrEqual(folderReal, page)) {
    refuse('outside_folder')
  }
  return page
}

async function openPage(page: string): Promise<FileHandle> {
  try {
    return await open(page, VISUAL_OPEN_FLAGS)
  } catch (error) {
    if (isAbsence(error)) {
      refuse('not_found')
    }
    // ELOOP: the resolved path became a symlink between the realpath and the open.
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'EMLINK') {
      refuse('outside_folder')
    }
    if (errorCode(error) === 'EISDIR') {
      refuse('not_a_file')
    }
    throw error
  }
}

/** After the open: the handle must still be the file the contained canonical path names. */
async function assertStillContained(page: string, opened: Stats): Promise<void> {
  let current: Stats
  try {
    if ((await realpath(page)) !== page) {
      refuse('outside_folder')
    }
    current = await lstat(page)
  } catch (error) {
    if (error instanceof VisualReadRefusal) {
      throw error
    }
    if (isAbsence(error)) {
      refuse('not_found')
    }
    throw error
  }
  if (current.isSymbolicLink() || !sameFile(current, opened)) {
    refuse('outside_folder')
  }
}

function decodeVisualText(buffer: Buffer): string {
  if (buffer.includes(0)) {
    refuse('not_text')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return refuse('not_text')
  }
}

export function nativeChatVisualRevision(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, REVISION_HEX_LENGTH)
}

async function readContained(
  folder: string,
  path: string,
  knownRevision: string | undefined
): Promise<AgentSessionReadVisualResult> {
  if (!isNativeChatVisualPath(path)) {
    refuse('outside_folder')
  }
  const page = await containedPage(folder, path)
  const handle = await openPage(page)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      refuse('not_a_file')
    }
    if (stats.size > NATIVE_CHAT_VISUAL_MAX_BYTES) {
      refuse('too_large')
    }
    await assertStillContained(page, stats)
    let buffer: Buffer
    try {
      buffer = await readLocalFileBounded(handle, NATIVE_CHAT_VISUAL_MAX_BYTES, stats.size)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('File too large')) {
        refuse('too_large')
      }
      throw error
    }
    const html = decodeVisualText(buffer)
    const revision = nativeChatVisualRevision(buffer)
    const sizeBytes = buffer.length
    return knownRevision === revision
      ? { ok: true, revision, sizeBytes, unchanged: true }
      : { ok: true, revision, sizeBytes, html }
  } finally {
    await handle.close()
  }
}

/**
 * The visual at `path` under the chat's `folder`, or the refusal the host observed. Unexpected
 * filesystem faults still throw, so the client reads them as unavailable rather than as a verdict
 * about the file; the thrown error names only the error code, never a host path.
 */
export async function readNativeChatVisualFile(
  folder: string,
  path: string,
  knownRevision?: string
): Promise<AgentSessionReadVisualResult> {
  try {
    return await readContained(folder, path, knownRevision)
  } catch (error) {
    if (error instanceof VisualReadRefusal) {
      return { ok: false, error: error.refusal }
    }
    throw new Error(`visual_read_failed:${errorCode(error) ?? 'unknown'}`, { cause: error })
  }
}
