// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readRuntimeFilePreview = vi.fn()
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFilePreview: (...args: unknown[]) => readRuntimeFilePreview(...args)
}))
const openNativeChatVisualFile = vi.fn()
vi.mock('./native-chat-visual-open', () => ({
  openNativeChatVisualFile: (...args: unknown[]) => openNativeChatVisualFile(...args)
}))
const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('@/components/artifacts/artifact-published-link-client', () => ({
  getPublishedArtifactLink: () => Promise.resolve(null)
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))
const FILE_LINK_CONTEXT = {
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}
const fileLink = vi.hoisted(() => {
  const state: { context: unknown; hostResolved: boolean } = { context: null, hostResolved: true }
  return state
})
vi.mock('@/components/terminal-pane/terminal-file-path-mapping', () => ({
  getTerminalFileContext: (worktreeId: string, worktreePath: string) => ({
    target: { kind: 'local' },
    worktreeId,
    worktreePath,
    sourceHostResolved: fileLink.hostResolved
  })
}))
vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => fileLink.context
}))

import { NativeChatMarkdown } from './NativeChatMarkdown'
import { MessageRow } from './NativeChatMessageRow'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from './native-chat-visual-owner'
import { clearNativeChatVisualFileCacheForTests } from './native-chat-visual-file'
import {
  NativeChatFileLinkExistenceContext,
  type NativeChatFileLinkExistence
} from './native-chat-file-link-existence'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'

const owner: NativeChatVisualOwner = {
  target: { kind: 'local' },
  worktreeId: 'wt-1',
  tabId: 'tab-1'
}
const LINE = '::orca-visual{path="reports/usage.html" title="Usage"}'
const LEGACY_LINE = '::orca-visual{file="usage.html"}'
const PAGE_PATH = '/repo/reports/usage.html'

/** A chat's file-link checker, reduced to the recheck count a visual re-reads on. */
function fakeExistence(): NativeChatFileLinkExistence & { fire: () => void } {
  let generation = 0
  const listeners = new Set<() => void>()
  const fire = (): void => {
    generation += 1
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    watch: () => {
      throw new Error('not used')
    },
    recheck: fire,
    fire,
    recheckGeneration: () => generation,
    subscribeRecheck: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function withOwner(
  children: ReactNode,
  value: NativeChatVisualOwner | null = owner,
  existence: NativeChatFileLinkExistence | null = null
): ReactNode {
  return (
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={value}>
        <NativeChatFileLinkExistenceContext.Provider value={existence}>
          {children}
        </NativeChatFileLinkExistenceContext.Provider>
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

function frameDocument(container: HTMLElement): string {
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

function fileChange(
  kind: 'update' | 'overflow',
  absolutePath: string,
  runtimeEnvironmentId: string | null = null
): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        payload: { worktreePath: '/repo', events: [{ kind, absolutePath }] },
        runtimeEnvironmentId
      }
    })
  )
}

// The transcript mounts a visual once it scrolls near; here every visual is in view at once.
class InViewObserver {
  constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }])
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', InViewObserver)
  clearNativeChatVisualFileCacheForTests()
  fileLink.context = FILE_LINK_CONTEXT
  fileLink.hostResolved = true
  readRuntimeFilePreview.mockReset()
  openNativeChatVisualFile.mockReset()
  readRuntimeFilePreview.mockResolvedValue({ content: '<p>v</p>', isBinary: false })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NativeChatMarkdown visuals', () => {
  it('still renders an existing reply after inline visuals are turned off', async () => {
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), nativeChatInlineVisuals: false }
    })
    try {
      const { container } = render(
        withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
      )
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      expect(container).not.toHaveTextContent('::orca-visual')
    } finally {
      useAppStore.setState({ settings })
    }
  })

  it("reads the page from the chat's folder and opens it as the workspace file it is", async () => {
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'local' }, worktreeId: 'wt-1' }),
      PAGE_PATH,
      { kind: 'chat-html' }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))
    expect(openNativeChatVisualFile).toHaveBeenCalledWith('reports/usage.html', FILE_LINK_CONTEXT)
  })

  it("shows an older host's per-chat folder line as text and reads nothing", () => {
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LEGACY_LINE} visualMessageId="m1" />)
    )
    expect(container).toHaveTextContent('::orca-visual{file="usage.html"}')
    expect(readRuntimeFilePreview).not.toHaveBeenCalled()
  })

  it("keeps the placeholder and reads nothing until a floating chat's folder is pinned", () => {
    fileLink.context = null
    render(withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />))
    expect(screen.getByRole('status', { name: 'Loading visualization' })).toBeInTheDocument()
    expect(readRuntimeFilePreview).not.toHaveBeenCalled()
  })

  it("shows unavailable and reads nothing when no single owner names the workspace's host", async () => {
    fileLink.hostResolved = false
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
    )
    await waitFor(() => expect(container).toHaveTextContent('Visualization unavailable'))
    expect(readRuntimeFilePreview).not.toHaveBeenCalled()
  })

  it('reads a floating chat page in the home folder by its pinned path', async () => {
    fileLink.context = {
      worktreeId: 'global-floating-terminal',
      worktreePath: '/Users/me',
      runtimeEnvironmentId: null
    }
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.anything(),
      '/Users/me/reports/usage.html',
      { kind: 'chat-html' }
    )
  })

  it('re-reads at a recheck (turn end) and rebuilds the frame only when the page changed', async () => {
    const existence = fakeExistence()
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />, owner, existence)
    )
    await waitFor(() => expect(frameDocument(container)).toContain('<p>v</p>'))
    const frame = container.querySelector('iframe')
    const shown = frameDocument(container)

    act(() => existence.fire())
    await waitFor(() => expect(readRuntimeFilePreview).toHaveBeenCalledTimes(2))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(frameDocument(container)).toBe(shown)

    readRuntimeFilePreview.mockResolvedValue({ content: '<p>v2</p>', isBinary: false })
    act(() => existence.fire())
    await waitFor(() => expect(frameDocument(container)).toContain('<p>v2</p>'))
  })

  it('an earlier reply naming the same path shows the rewritten page at the recheck', async () => {
    const existence = fakeExistence()
    const { container } = render(
      withOwner(
        <>
          <NativeChatMarkdown content={LINE} visualMessageId="m1" />
          <NativeChatMarkdown content={LINE} visualMessageId="m2" />
        </>,
        owner,
        existence
      )
    )
    await waitFor(() => expect(container.querySelectorAll('iframe')).toHaveLength(2))
    readRuntimeFilePreview.mockResolvedValue({ content: '<p>rewritten</p>', isBinary: false })
    act(() => existence.fire())
    await waitFor(() =>
      container
        .querySelectorAll('iframe')
        .forEach((frame) => expect(frame.getAttribute('srcdoc')).toContain('<p>rewritten</p>'))
    )
  })

  it('keeps the shown page when the host cannot be reached, and drops it when the file is gone', async () => {
    const existence = fakeExistence()
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />, owner, existence)
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    readRuntimeFilePreview.mockRejectedValue(new Error('Runtime environment is unreachable'))
    act(() => existence.fire())
    await waitFor(() => expect(readRuntimeFilePreview).toHaveBeenCalledTimes(2))
    expect(container.querySelector('iframe')).not.toBeNull()

    readRuntimeFilePreview.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    act(() => existence.fire())
    await waitFor(() => expect(container).toHaveTextContent('Visualization unavailable'))
    expect(container.querySelector('iframe')).toBeNull()
  })

  it("re-reads when another view's watch reports this file, and ignores other paths and hosts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = render(
        withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
      )
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)

      fileChange('update', '/repo/reports/other.html')
      fileChange('update', PAGE_PATH, 'env-other')
      await act(() => vi.advanceTimersByTimeAsync(500))
      expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)

      readRuntimeFilePreview.mockResolvedValue({ content: '<p>saved</p>', isBinary: false })
      fileChange('update', PAGE_PATH)
      fileChange('update', PAGE_PATH)
      await act(() => vi.advanceTimersByTimeAsync(500))
      await waitFor(() => expect(frameDocument(container)).toContain('<p>saved</p>'))
      expect(readRuntimeFilePreview).toHaveBeenCalledTimes(2)

      fileChange('overflow', '/repo')
      await act(() => vi.advanceTimersByTimeAsync(500))
      expect(readRuntimeFilePreview).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['binary', { content: '', isBinary: true }],
    ['over 512 KiB', { content: 'a'.repeat(512 * 1024 + 1), isBinary: false }]
  ])('shows a %s file as unavailable', async (_name, result) => {
    readRuntimeFilePreview.mockResolvedValue(result)
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
    )
    await waitFor(() => expect(container).toHaveTextContent('Visualization unavailable'))
  })

  describe('Share', () => {
    const SHARE = { name: 'Share as artifact' }

    beforeEach(() => {
      useAppStore.setState({
        orcaProfileAuthStatus: {
          activeProfileId: 'p1',
          configured: true,
          state: 'connected',
          persistence: 'none'
        },
        settings: { ...getDefaultSettings('/tmp'), artifactSharingEnabled: true }
      })
      callRuntimeRpc.mockReset()
      callRuntimeRpc.mockResolvedValue({
        status: 'ok',
        value: { change: 'updated', item: { shareUrl: 'https://example.test/a' } }
      })
      toastError.mockReset()
    })

    /** Shows the page, lets `changeFile` act on the file (unseen by any watch), then shares. */
    async function shareShownVisual(changeFile: () => void): Promise<HTMLElement> {
      const { container } = render(
        withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
      )
      await waitFor(() => expect(frameDocument(container)).toContain('<p>v</p>'))
      changeFile()
      fireEvent.click(screen.getByRole('button', SHARE))
      fireEvent.click(await screen.findByRole('button', { name: 'Generate link' }))
      return container
    }

    it('publishes the file as saved since it was shown, once, and shows it in the frame', async () => {
      const container = await shareShownVisual(() =>
        readRuntimeFilePreview.mockResolvedValue({ content: '<p>saved</p>', isBinary: false })
      )

      await waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledOnce())
      expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'artifacts.publish', {
        sourceKey: PAGE_PATH,
        content: '<p>saved</p>',
        contentType: 'text/html',
        fileName: 'usage.html'
      })
      expect(readRuntimeFilePreview).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(frameDocument(container)).toContain('<p>saved</p>'))
    })

    it('keeps the shown page and reports unreadable when the file cannot be read', async () => {
      const container = await shareShownVisual(() =>
        readRuntimeFilePreview.mockRejectedValue(new Error('ENOENT: no such file or directory'))
      )

      await waitFor(() => expect(toastError).toHaveBeenCalledOnce())
      expect(toastError).toHaveBeenCalledWith('Could not share artifact', {
        description: "Orca couldn't read this file. Open it from a workspace and try again."
      })
      expect(callRuntimeRpc).not.toHaveBeenCalled()
      expect(frameDocument(container)).toContain('<p>v</p>')
    })

    it('keeps the hover toolbar shown while its Share popover is open', async () => {
      const { container } = render(
        withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
      )
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
      const toolbar = screen.getByRole('button', SHARE).parentElement
      expect(toolbar).toHaveClass('data-[share-open=true]:opacity-100')
      expect(toolbar).toHaveAttribute('data-share-open', 'false')

      fireEvent.click(screen.getByRole('button', SHARE))
      await screen.findByRole('button', { name: 'Generate link' })
      expect(toolbar).toHaveAttribute('data-share-open', 'true')

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      await waitFor(() => expect(toolbar).toHaveAttribute('data-share-open', 'false'))
    })

    it('is not offered for an unavailable visual or before a floating chat is pinned', async () => {
      fileLink.hostResolved = false
      const { container } = render(
        withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
      )
      await waitFor(() => expect(container).toHaveTextContent('Visualization unavailable'))
      expect(screen.queryByRole('button', SHARE)).toBeNull()
      cleanup()

      fileLink.context = null
      render(withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />))
      expect(screen.getByRole('status', { name: 'Loading visualization' })).toBeInTheDocument()
      expect(screen.queryByRole('button', SHARE)).toBeNull()
    })
  })

  it('holds back an unfinished directive at the end of a streaming reply', () => {
    const { container } = render(
      withOwner(
        <NativeChatMarkdown
          content={'Here it is:\n::orca-visual{path="usa'}
          visualMessageId="m1"
          streaming
        />
      )
    )
    expect(container).toHaveTextContent('Here it is:')
    expect(container).not.toHaveTextContent('::orca-visual')
  })

  it('shows unfinished syntax as text once the reply is no longer streaming', () => {
    const { container } = render(
      withOwner(
        <NativeChatMarkdown content={'Here it is:\n::orca-visual{path="usa'} visualMessageId="m1" />
      )
    )
    expect(container).toHaveTextContent('::orca-visual{path="usa')
  })

  it('keeps a mounted visual frame while the rest of the reply streams in', async () => {
    const { container, rerender } = render(
      withOwner(
        <NativeChatMarkdown content={`Intro\n\n${LINE}\n\nMore`} visualMessageId="m1" streaming />
      )
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const frame = container.querySelector('iframe')
    rerender(
      withOwner(
        <NativeChatMarkdown
          content={`Intro\n\n${LINE}\n\nMore text arriving now`}
          visualMessageId="m1"
          streaming
        />
      )
    )
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container).toHaveTextContent('More text arriving now')
    expect(readRuntimeFilePreview).toHaveBeenCalledTimes(1)
  })

  it('shows one muted line when the file is missing', async () => {
    readRuntimeFilePreview.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    const { container } = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />)
    )
    await waitFor(() => expect(container).toHaveTextContent('Visualization unavailable'))
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('leaves the line as text where visuals do not apply', () => {
    const noMessage = render(withOwner(<NativeChatMarkdown content={LINE} />))
    expect(noMessage.container).toHaveTextContent('::orca-visual')
    cleanup()
    const noOwner = render(
      withOwner(<NativeChatMarkdown content={LINE} visualMessageId="m1" />, null)
    )
    expect(noOwner.container).toHaveTextContent('::orca-visual')
    expect(readRuntimeFilePreview).not.toHaveBeenCalled()
  })

  it('holds the tail of a text row while its turn works, though the row carries no state', () => {
    const row = (activeTurnIsWorking: boolean, trailingRun = true) =>
      withOwner(
        <MessageRow
          message={{
            id: 'm1',
            role: 'assistant',
            timestamp: 0,
            source: 'transcript',
            blocks: [{ type: 'text', text: 'Here it is:\n::orca-visual{path="usa' }]
          }}
          expandSignal={false}
          activeTurnIsWorking={activeTurnIsWorking}
          trailingRun={trailingRun}
          onScrollMessageToTop={vi.fn()}
        />
      )
    const { container, rerender } = render(row(true))
    expect(container).toHaveTextContent('Here it is:')
    expect(container).not.toHaveTextContent('::orca-visual')
    rerender(row(false))
    expect(container).toHaveTextContent('::orca-visual{path="usa')
    // An earlier row of a still-working turn has stopped growing, so it shows what it says.
    rerender(row(true, false))
    expect(container).toHaveTextContent('::orca-visual{path="usa')
  })
})
