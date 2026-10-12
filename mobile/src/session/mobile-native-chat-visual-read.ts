import { filePreviewTextRead } from '../files/mobile-file-preview-operations'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'

/** A chat's visuals are files in its workspace, read the way the phone's file viewer reads them. */
export type MobileNativeChatVisualSource = {
  client: RpcClient
  hostId: string
  worktreeId: string
}

export type MobileNativeChatVisualRead =
  | { kind: 'ready'; html: string }
  /** The host answered: missing, binary, too large, or outside what the phone may read. */
  | { kind: 'refused' }
  /** No answer. Worth asking again. */
  | { kind: 'unreachable' }

const READ_TIMEOUT_MS = 15_000
// Each entry is at most 512 KiB of UTF-8; the character bound is what caps memory.
const MAX_CACHE_ENTRIES = 16
const MAX_CACHE_CHARS = 4 * 1024 * 1024

const cache = new Map<string, string>()
const inFlight = new Map<string, Promise<MobileNativeChatVisualRead>>()

// The client stands for the host: each paired host has its own, so one host's visuals never
// answer for another's even if two workspace ids collided.
const clientKeys = new WeakMap<RpcClient, number>()
let nextClientKey = 0

function cacheKey(source: MobileNativeChatVisualSource, path: string): string {
  let clientKey = clientKeys.get(source.client)
  if (clientKey === undefined) {
    nextClientKey += 1
    clientKey = nextClientKey
    clientKeys.set(source.client, clientKey)
  }
  return JSON.stringify([clientKey, source.hostId, source.worktreeId, path])
}

function remember(key: string, html: string): void {
  cache.delete(key)
  cache.set(key, html)
  let chars = 0
  for (const value of cache.values()) {
    chars += value.length
  }
  // Oldest first: Map iteration follows insertion order, and a hit re-inserts.
  for (const [oldKey, value] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && chars <= MAX_CACHE_CHARS) {
      break
    }
    if (oldKey === key) {
      continue
    }
    cache.delete(oldKey)
    chars -= value.length
  }
}

/** What this phone already holds for a visual, to paint before reading it again. */
export function cachedMobileNativeChatVisual(
  source: MobileNativeChatVisualSource,
  path: string
): string | null {
  return cache.get(cacheKey(source, path)) ?? null
}

async function readOnce(
  source: MobileNativeChatVisualSource,
  path: string,
  key: string
): Promise<MobileNativeChatVisualRead> {
  let response
  try {
    response = await filePreviewTextRead.request(
      source.client,
      { worktree: `id:${source.worktreeId}`, relativePath: path },
      { timeoutMs: READ_TIMEOUT_MS, budgetSpansConnect: true }
    )
  } catch {
    return { kind: 'unreachable' }
  }
  let reply
  try {
    reply = filePreviewTextRead.interpret(response)
  } catch {
    // An unreadable answer is not a verdict on the file.
    return { kind: 'unreachable' }
  }
  // Why truncated: the host reads at most 512 KiB for a phone, the visual size cap.
  if (!reply.accepted || reply.value.truncated === true || reply.value.isBinary === true) {
    // The host no longer serves it as a page: stop painting the old bytes.
    cache.delete(key)
    return { kind: 'refused' }
  }
  remember(key, reply.value.content)
  return { kind: 'ready', html: reply.value.content }
}

/**
 * Reads one visual from the chat's workspace on its host. Concurrent reads of the same visual
 * share one request. A floating chat's folder is pinned when it starts, which `files.read` cannot
 * name (it reads the current floating folder), so those show as unavailable without asking.
 */
export function readMobileNativeChatVisual(
  source: MobileNativeChatVisualSource,
  path: string
): Promise<MobileNativeChatVisualRead> {
  if (source.worktreeId === FLOATING_WORKSPACE_WORKTREE_ID) {
    return Promise.resolve({ kind: 'refused' })
  }
  const key = cacheKey(source, path)
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const read = readOnce(source, path, key).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, read)
  return read
}

/** Test seam: forget every cached visual. */
export function resetMobileNativeChatVisualCacheForTest(): void {
  cache.clear()
  inFlight.clear()
}
