import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'

const owners = new Map<string, StructuredAgentSessionReadOwner>()
const ownerListeners = new Map<
  string,
  Set<(owner: StructuredAgentSessionReadOwner | undefined) => void>
>()
function notifyOwner(key: string): void {
  for (const listener of Array.from(ownerListeners.get(key) ?? [])) {
    try {
      listener(owners.get(key))
    } catch (error) {
      console.warn('[native-chat] observing a reader failed', error)
    }
  }
}
/** Observe existing readers without starting a hidden conversation read. */
export function subscribeStructuredReadOwner(
  sessionId: string,
  target: RuntimeClientTarget,
  listener: (owner: StructuredAgentSessionReadOwner | undefined) => void
): () => void {
  const key = structuredReadOwnerKey(sessionId, target)
  const listeners =
    ownerListeners.get(key) ??
    new Set<(owner: StructuredAgentSessionReadOwner | undefined) => void>()
  listeners.add(listener)
  ownerListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      ownerListeners.delete(key)
    }
  }
}
export function structuredReadOwnerKey(sessionId: string, target: RuntimeClientTarget): string {
  return `${target.kind === 'local' ? 'local' : `environment:${target.environmentId}`}:${sessionId}`
}
export function findStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner | undefined {
  return owners.get(structuredReadOwnerKey(sessionId, target))
}
/** A closed chat no longer needs an unmounted create page or an active reader. */
export function retireStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): void {
  const key = structuredReadOwnerKey(sessionId, target)
  const owner = owners.get(key)
  owners.delete(key)
  try {
    owner?.dispose()
  } catch (error) {
    console.warn('[native-chat] retiring a conversation reader failed', error)
  } finally {
    notifyOwner(key)
  }
}
export function getOrCreateStructuredReadOwner(
  key: string,
  create: () => StructuredAgentSessionReadOwner
): StructuredAgentSessionReadOwner {
  const existing = owners.get(key)
  if (existing) {
    return existing
  }
  const owner = create()
  owners.set(key, owner)
  notifyOwner(key)
  return owner
}
/** A held owner names its key again once its last holders released it, never over a live one. */
export function adoptStructuredReadOwner(
  key: string,
  owner: StructuredAgentSessionReadOwner
): void {
  if (!owners.has(key)) {
    owners.set(key, owner)
    notifyOwner(key)
  }
}
export function forgetStructuredReadOwner(
  key: string,
  owner: StructuredAgentSessionReadOwner
): void {
  if (owners.get(key) === owner) {
    owners.delete(key)
    notifyOwner(key)
  }
}
export function resetStructuredAgentSessionReadOwnersForTests(): void {
  for (const owner of owners.values()) {
    owner.dispose()
  }
  owners.clear()
}
