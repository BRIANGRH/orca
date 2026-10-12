import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  noteRendererHeapHighwater,
  noteRendererMemorySample,
  profileRendererHeapHighwaterBreadcrumb,
  resetRendererHeapAllocationProfilesForTests,
  summarizeSamplingProfile,
  type ProfiledRenderer
} from './renderer-heap-allocation-profile'
import {
  getCrashBreadcrumbSnapshot,
  clearCrashBreadcrumbsForTest
} from './crash-breadcrumb-store'

function frame(functionName: string, url: string, lineNumber = 9, columnNumber = 4) {
  return { functionName, url, lineNumber, columnNumber, scriptId: '1' }
}

const APP = 'file:///Users/someone/Applications/Orca.app/Contents/Resources/app.asar/out/renderer/assets'

const profile = {
  head: {
    callFrame: frame('(root)', ''),
    selfSize: 0,
    children: [
      {
        callFrame: frame('appendChunk', `${APP}/terminal-Ab12.js`),
        selfSize: 0,
        children: [
          { callFrame: frame('sliceOutput', `${APP}/terminal-Ab12.js`, 20), selfSize: 3 * 1024 * 1024 },
          { callFrame: frame('evil', 'data:text/javascript,secret/stuff.js'), selfSize: 512 * 1024 }
        ]
      },
      { callFrame: frame('(V8 API)', ''), selfSize: 1024 * 1024 }
    ]
  }
}

function fakeRenderer(id = 1, attached = false) {
  const destroyed: (() => void)[] = []
  const detachListeners = new Set<() => void>()
  let isAttached = attached
  const sendCommand = vi.fn(async (method: string) =>
    method === 'HeapProfiler.getSamplingProfile' ? { profile } : {}
  )
  const renderer: ProfiledRenderer = {
    id,
    isDestroyed: () => false,
    once: (_event, listener) => destroyed.push(listener),
    debugger: {
      isAttached: () => isAttached,
      attach: vi.fn(() => {
        isAttached = true
      }),
      detach: vi.fn(() => {
        isAttached = false
      }),
      sendCommand,
      on: (_event, listener) => detachListeners.add(listener),
      removeListener: (_event, listener) => detachListeners.delete(listener)
    }
  }
  return { renderer, sendCommand, destroy: () => destroyed.forEach((listener) => listener()) }
}

afterEach(() => {
  resetRendererHeapAllocationProfilesForTests()
  clearCrashBreadcrumbsForTest()
})

describe('summarizeSamplingProfile', () => {
  it('names allocation sites by bundle file and line, never paths or script content', () => {
    const summary = summarizeSamplingProfile(profile)

    expect(summary).toEqual({
      sampledLiveMB: 5,
      siteCount: 3,
      site01: '3072KB sliceOutput@terminal-Ab12.js:21:5 < appendChunk@terminal-Ab12.js:10:5',
      site02: '1024KB (V8 API)',
      site03: '512KB evil@(script):10:5 < appendChunk@terminal-Ab12.js:10:5'
    })
    expect(JSON.stringify(summary)).not.toContain('someone')
    expect(JSON.stringify(summary)).not.toContain('secret')
  })
})

describe('noteRendererHeapHighwater', () => {
  it('starts sampling at the first heap mark and refreshes the profile on later samples', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { renderer, sendCommand } = fakeRenderer()
    const record = vi.fn()

    noteRendererHeapHighwater(renderer, 60, 'main', record)
    await vi.waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith('HeapProfiler.startSampling', {
        samplingInterval: 512 * 1024
      })
    )
    noteRendererMemorySample(renderer, record)
    expect(record).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 60_000)
    noteRendererMemorySample(renderer, record)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    expect(record.mock.calls[0][0]).toMatchObject({
      rendererSurface: 'main',
      startedAtPct: 60,
      sampledMinutes: 1,
      sampledLiveMB: 5
    })

    noteRendererHeapHighwater(renderer, 80, 'main', record)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(renderer.debugger.attach).toHaveBeenCalledTimes(1)
    expect(renderer.debugger.detach).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('never takes over a debugger that is already attached', () => {
    const { renderer, sendCommand } = fakeRenderer(2, true)

    noteRendererHeapHighwater(renderer, 60, 'main', vi.fn())

    expect(renderer.debugger.attach).not.toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('stops sampling when the renderer goes away before the next mark', async () => {
    const { renderer, destroy } = fakeRenderer(3)
    noteRendererHeapHighwater(renderer, 60, 'main', vi.fn())

    destroy()

    expect(renderer.debugger.detach).toHaveBeenCalled()
    expect(renderer.debugger.sendCommand).toHaveBeenCalledWith('HeapProfiler.stopSampling')
  })
})

describe('profileRendererHeapHighwaterBreadcrumb', () => {
  it('records a retained profile crumb for heap-ratio marks only', async () => {
    const { renderer, sendCommand } = fakeRenderer(4)
    const origin = 'renderer:4'

    profileRendererHeapHighwaterBreadcrumb(
      renderer,
      { name: 'renderer_memory_highwater', data: { rendererSurface: 'main', thresholdPrivateMB: 600 } },
      origin
    )
    expect(renderer.debugger.attach).not.toHaveBeenCalled()

    profileRendererHeapHighwaterBreadcrumb(
      renderer,
      { name: 'renderer_memory_highwater', data: { rendererSurface: 'main', thresholdPct: 60 } },
      origin
    )
    await vi.waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith('HeapProfiler.startSampling', expect.anything())
    )
    profileRendererHeapHighwaterBreadcrumb(
      renderer,
      { name: 'renderer_memory_highwater', data: { rendererSurface: 'main', thresholdPct: 80 } },
      origin
    )

    await vi.waitFor(() =>
      expect(getCrashBreadcrumbSnapshot().map((crumb) => crumb.name)).toContain(
        'renderer_heap_allocation_profile'
      )
    )
    const crumb = getCrashBreadcrumbSnapshot().find(
      (entry) => entry.name === 'renderer_heap_allocation_profile'
    )
    expect(crumb?.origin).toBe(origin)
    expect(crumb?.data?.site01).toContain('sliceOutput@terminal-Ab12.js:21:5')
  })
})
