/**
 * Renderer memory pressure: the periodic memory sample past the top
 * high-water marks wakes subsystems that can release memory on demand.
 *
 * Why a listener registry: crash-diagnostics must stay a leaf module, so
 * subsystems register a release callback instead of being imported.
 */

// Why: the same top marks that arm the high-water census (renderer-memory-sampling.ts).
export const RENDERER_MEMORY_PRESSURE_PRIVATE_MB = 1000
export const RENDERER_MEMORY_PRESSURE_HEAP_RATIO = 0.8

const listeners = new Set<() => void>()

export function onRendererMemoryPressure(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isRendererMemoryUnderPressure(sample: {
  privateMB: number | null
  heapRatio: number | null
}): boolean {
  return (
    (sample.privateMB !== null && sample.privateMB >= RENDERER_MEMORY_PRESSURE_PRIVATE_MB) ||
    (sample.heapRatio !== null && sample.heapRatio >= RENDERER_MEMORY_PRESSURE_HEAP_RATIO)
  )
}

export function notifyRendererMemoryPressure(): void {
  for (const listener of listeners) {
    // Why: one failing release must not stop the others or the sampler.
    try {
      listener()
    } catch {
      // Best-effort release.
    }
  }
}
