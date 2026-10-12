import type { StructuredAgentSessionReadOwner } from './native-chat/structured-agent-session-read-owner'
export const RESUME_RUN_SOURCE_READ_BUDGET_MS = 30_000
const MAX_OWNED_READS = 4
/** Only result-owned activations are bounded; a visible pane keeps its own retry policy. */
export function createResumeSourceReadLeases(deps: {
  prepare: (id: string) => StructuredAgentSessionReadOwner | undefined
  expired: (id: string) => void
}) {
  let stopped = false
  let draining = false
  const queued = new Set<string>()
  const owned = new Map<string, { timer: ReturnType<typeof setTimeout>; deactivate?: () => void }>()
  const drain = () => {
    if (draining) {
      return
    }
    draining = true
    try {
      for (const id of queued) {
        if (stopped || owned.size >= MAX_OWNED_READS) {
          return
        }
        queued.delete(id)
        const owner = deps.prepare(id)
        if (!owner || owner.hasActiveReaders()) {
          continue
        }
        const lease: { timer: ReturnType<typeof setTimeout>; deactivate?: () => void } = {
          timer: setTimeout(() => {
            deps.expired(id)
            release(id)
          }, RESUME_RUN_SOURCE_READ_BUDGET_MS)
        }
        owned.set(id, lease)
        const deactivate = owner.activate()
        if (owned.get(id) === lease) {
          lease.deactivate = deactivate
        } else {
          deactivate()
        }
      }
    } finally {
      draining = false
    }
  }
  const release = (id: string) => {
    const lease = owned.get(id)
    owned.delete(id)
    queued.delete(id)
    if (lease) {
      clearTimeout(lease.timer)
      lease.deactivate?.()
    }
    drain()
  }
  return {
    has: (id: string) => owned.has(id),
    admit: (id: string) => {
      if (!stopped && !owned.has(id)) {
        queued.add(id)
        drain()
      }
    },
    release,
    dispose: () => {
      stopped = true
      queued.clear()
      for (const id of owned.keys()) {
        release(id)
      }
    }
  }
}
