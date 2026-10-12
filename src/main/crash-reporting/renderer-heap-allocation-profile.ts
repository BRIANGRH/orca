import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import {
  RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'

// Why 512 KB: V8's sampler then records ~2 stacks per MB allocated, cheap enough to leave on near OOM.
const SAMPLING_INTERVAL_BYTES = 512 * 1024
const MAX_SITES = 12
const MAX_STACK_FRAMES = 4
const MAX_FUNCTION_NAME_LENGTH = 48
const MAX_FILE_NAME_LENGTH = 64
const SCRIPT_FILE_NAME = /^[\w.-]+\.[cm]?js$/
const BUNDLE_SCRIPT_URL = /^(?:file|https?):\/\//

type SamplingProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }
  selfSize: number
  children?: SamplingProfileNode[]
}
type SamplingProfile = { head: SamplingProfileNode }

export type ProfiledDebugger = {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'detach', listener: () => void): unknown
  removeListener(event: 'detach', listener: () => void): unknown
}

export type ProfiledRenderer = {
  id: number
  debugger: ProfiledDebugger
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}

type SamplingSession = {
  rendererSurface: string
  startedAtPct: number
  startedAtMs: number
  release: () => void
}

const sessions = new Map<number, SamplingSession>()
const finishedRenderers = new Set<number>()

/**
 * Called for every renderer heap high-water crumb. The first heap mark starts V8's
 * sampling heap profiler; the next one reads which code allocated the memory still
 * alive since then and records it, so the report names the retainer's allocation site.
 */
export function noteRendererHeapHighwater(
  renderer: ProfiledRenderer,
  thresholdPct: number,
  rendererSurface: string,
  record: (data: CrashReportBreadcrumbData) => void
): void {
  if (renderer.isDestroyed() || finishedRenderers.has(renderer.id)) {
    return
  }
  const session = sessions.get(renderer.id)
  if (!session) {
    startSampling(renderer, thresholdPct, rendererSurface)
    return
  }
  if (thresholdPct <= session.startedAtPct) {
    return
  }
  finishedRenderers.add(renderer.id)
  void renderer.debugger
    .sendCommand('HeapProfiler.getSamplingProfile')
    .then((result) => {
      const profile = readSamplingProfile(result)
      if (profile) {
        record({
          rendererSurface: session.rendererSurface,
          startedAtPct: session.startedAtPct,
          thresholdPct,
          sampledMinutes: Math.round((Date.now() - session.startedAtMs) / 60_000),
          ...summarizeSamplingProfile(profile)
        })
      }
    })
    .catch(() => undefined)
    .finally(() => session.release())
}

/** Feeds a renderer-sent breadcrumb to the profiler; only heap-ratio high-water marks count. */
export function profileRendererHeapHighwaterBreadcrumb(
  renderer: ProfiledRenderer,
  args: { name?: unknown; data?: unknown } | undefined,
  origin: string
): void {
  const data = args?.data
  if (args?.name !== 'renderer_memory_highwater' || !data || typeof data !== 'object') {
    return
  }
  const thresholdPct = 'thresholdPct' in data ? data.thresholdPct : undefined
  const rendererSurface = 'rendererSurface' in data ? data.rendererSurface : undefined
  if (typeof thresholdPct !== 'number' || !Number.isFinite(thresholdPct)) {
    return
  }
  noteRendererHeapHighwater(
    renderer,
    thresholdPct,
    typeof rendererSurface === 'string' ? rendererSurface : 'unknown',
    (data) => recordCrashBreadcrumb(RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB, data, origin)
  )
}

function startSampling(renderer: ProfiledRenderer, thresholdPct: number, surface: string): void {
  const debug = renderer.debugger
  // Why: never take over a debugger someone else (DevTools, an automation) attached.
  if (debug.isAttached()) {
    return
  }
  try {
    debug.attach('1.3')
  } catch {
    return
  }
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    sessions.delete(renderer.id)
    debug.removeListener('detach', onDetach)
    if (!renderer.isDestroyed() && debug.isAttached()) {
      void debug.sendCommand('HeapProfiler.stopSampling').catch(() => undefined)
      try {
        debug.detach()
      } catch {
        // Already gone with the renderer.
      }
    }
  }
  const onDetach = (): void => {
    released = true
    sessions.delete(renderer.id)
    debug.removeListener('detach', onDetach)
  }
  debug.on('detach', onDetach)
  renderer.once('destroyed', () => {
    finishedRenderers.delete(renderer.id)
    release()
  })
  sessions.set(renderer.id, {
    rendererSurface: surface,
    startedAtPct: thresholdPct,
    startedAtMs: Date.now(),
    release
  })
  void debug
    .sendCommand('HeapProfiler.enable')
    .then(() =>
      debug.sendCommand('HeapProfiler.startSampling', {
        samplingInterval: SAMPLING_INTERVAL_BYTES
      })
    )
    .catch(release)
}

function readSamplingProfile(result: unknown): SamplingProfile | null {
  if (!result || typeof result !== 'object' || !('profile' in result)) {
    return null
  }
  const { profile } = result
  if (!profile || typeof profile !== 'object' || !('head' in profile)) {
    return null
  }
  const { head } = profile
  return isSamplingProfileNode(head) ? { head } : null
}

function isSamplingProfileNode(value: unknown): value is SamplingProfileNode {
  return (
    !!value &&
    typeof value === 'object' &&
    'callFrame' in value &&
    'selfSize' in value &&
    typeof value.selfSize === 'number' &&
    !!value.callFrame &&
    typeof value.callFrame === 'object'
  )
}

/**
 * Top allocation sites by sampled live bytes, as `KB fn@file:line < caller@file:line`.
 * Code locations only: file basenames of the app bundle, never paths, values or user data.
 */
export function summarizeSamplingProfile(profile: SamplingProfile): CrashReportBreadcrumbData {
  const sites = new Map<string, number>()
  let totalBytes = 0
  const walk: { node: SamplingProfileNode; stack: SamplingProfileNode[] }[] = [
    { node: profile.head, stack: [] }
  ]
  for (let item = walk.pop(); item; item = walk.pop()) {
    const { node, stack } = item
    const frames = node === profile.head ? stack : [node, ...stack].slice(0, MAX_STACK_FRAMES)
    if (node.selfSize > 0 && frames.length > 0) {
      totalBytes += node.selfSize
      const key = frames.map(describeFrame).join(' < ')
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize)
    }
    for (const child of node.children ?? []) {
      walk.push({ node: child, stack: frames })
    }
  }
  const top = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SITES)
  const data: CrashReportBreadcrumbData = {
    sampledLiveMB: Math.round(totalBytes / (1024 * 1024)),
    siteCount: sites.size
  }
  top.forEach(([key, bytes], index) => {
    data[`site${String(index + 1).padStart(2, '0')}`] = `${Math.round(bytes / 1024)}KB ${key}`
  })
  return data
}

function describeFrame(node: SamplingProfileNode): string {
  const { functionName, url, lineNumber, columnNumber } = node.callFrame
  const name = (functionName || '(anonymous)')
    .replace(/[^\w$.<>()[\] ]/g, '')
    .slice(0, MAX_FUNCTION_NAME_LENGTH)
  const baseName = url.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? ''
  // Why: only bundle file names; a data:/blob:/eval URL could carry page content.
  const file = !url
    ? ''
    : BUNDLE_SCRIPT_URL.test(url) && SCRIPT_FILE_NAME.test(baseName)
      ? baseName.slice(0, MAX_FILE_NAME_LENGTH)
      : '(script)'
  // Why: V8 reports native/runtime frames with no script; their name alone is the useful part.
  return file ? `${name}@${file}:${lineNumber + 1}:${columnNumber + 1}` : name
}

export function resetRendererHeapAllocationProfilesForTests(): void {
  for (const session of sessions.values()) {
    session.release()
  }
  sessions.clear()
  finishedRenderers.clear()
}
