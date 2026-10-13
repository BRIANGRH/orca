// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

type CommandItem = Extract<NativeChatPickerItem, { kind: 'command' }>

type FieldProps = {
  onSend?: () => void
  onChoosePickerItem?: (item: NativeChatPickerItem) => void
  notices?: readonly { text?: string }[]
}
type KeyDownArgs = {
  completePickerItem: (item: NativeChatPickerItem) => void
  dispatchPickerCommand: (item: CommandItem) => void
}

type Mocks = {
  draft: string
  imageAttachments: { id: string; path: string }[]
  setDraft: Mock<(...args: unknown[]) => unknown>
  clearImageAttachments: Mock<(...args: unknown[]) => unknown>
  openHistory: Mock<(...args: unknown[]) => unknown>
  workspaceLoaded: boolean
  sendNativeChatMessage: Mock<(...args: unknown[]) => unknown>
  sendNativeChatTypedCommand: Mock<(...args: unknown[]) => unknown>
  trackPendingSend: Mock<(...args: unknown[]) => unknown>
  fieldProps: FieldProps | null
  keyDownArgs: KeyDownArgs | null
}

const mocks = vi.hoisted((): Mocks => ({
  draft: '/resume',
  imageAttachments: [],
  setDraft: vi.fn(),
  clearImageAttachments: vi.fn(),
  openHistory: vi.fn(),
  workspaceLoaded: true,
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  trackPendingSend: vi.fn(),
  fieldProps: null,
  keyDownArgs: null
}))

vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: 'ssh:box',
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    unifiedTabsByWorktree: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('../right-sidebar/ai-vault-panel-workspace', () => ({
  selectAiVaultPanelWorkspace: () => ({
    worktree: mocks.workspaceLoaded ? { id: 'wt-1' } : null,
    repo: null
  })
}))
vi.mock('../right-sidebar/agent-session-history-modal', () => ({
  openAgentSessionHistoryModal: (...args: unknown[]) => mocks.openHistory(...args)
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => mocks.sendNativeChatTypedCommand(...args),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({
    draft: mocks.draft,
    setDraft: mocks.setDraft,
    flushDraftAppends: () => {}
  })
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: FieldProps) => {
    mocks.fieldProps = props
    return null
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: mocks.imageAttachments,
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: mocks.clearImageAttachments,
    flushPendingAttachments: vi.fn(),
    removeImageAttachment: vi.fn(),
    pendingChips: { begin: vi.fn(), resolve: vi.fn(), drop: vi.fn(), attachReferences: vi.fn() }
  })
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({ handlePaste: vi.fn(), pasteFromClipboard: vi.fn() })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('../dictation/dictation-control-events', () => ({ dispatchDictationControl: vi.fn() }))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: (args: KeyDownArgs) => {
    mocks.keyDownArgs = args
    return vi.fn()
  }
}))
vi.mock('./use-native-chat-send-lifecycle', () => ({
  useNativeChatSendLifecycle: () => ({
    cancelPendingSends: vi.fn(),
    trackPendingSend: mocks.trackPendingSend
  })
}))

import { NativeChatComposer } from './NativeChatComposer'

const RESUME: CommandItem = {
  kind: 'command',
  id: 'command:resume',
  name: 'resume',
  token: '/resume',
  skillCollision: false
}

function structuredTransport(): NativeChatStructuredComposerTransport {
  return {
    send: vi.fn(() => true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    worktreeId: 'wt-structured',
    runtimeEnvironmentId: null
  }
}

function renderTerminalChat(extra: {
  onOptimisticSend?: () => string
  onSlashCommand?: () => void
}) {
  return render(
    <NativeChatComposer
      terminalTabId="tab-1"
      paneKey="tab-1:leaf-1"
      targetPtyId="pty-1"
      agent="codex"
      {...extra}
    />
  )
}

describe('/resume in the native chat composer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.draft = '/resume'
    mocks.imageAttachments = []
    mocks.workspaceLoaded = true
    mocks.fieldProps = null
    mocks.keyDownArgs = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { git: { discoverCommitMessageModels: vi.fn(async () => ({ success: false })) } }
    })
  })
  afterEach(() => cleanup())

  it('opens history for a typed /resume with its search and sends nothing to the agent', () => {
    mocks.draft = '/resume  auth  retry'
    mocks.imageAttachments = [{ id: 'img-1', path: '/tmp/a.png' }]
    const onOptimisticSend = vi.fn(() => 'pending')
    const onSlashCommand = vi.fn()
    renderTerminalChat({ onOptimisticSend, onSlashCommand })

    act(() => mocks.fieldProps?.onSend?.())

    // A terminal chat's workspace comes from its tab, on the host the user is viewing.
    expect(mocks.openHistory).toHaveBeenCalledWith({
      workspace: { worktreeId: 'wt-1', executionHostId: 'ssh:box' },
      initialQuery: 'auth retry'
    })
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(mocks.trackPendingSend).not.toHaveBeenCalled()
    expect(onOptimisticSend).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
    // Attachments stay for the next real prompt.
    expect(mocks.clearImageAttachments).not.toHaveBeenCalled()
  })

  it("opens a structured chat's history from its own workspace without sending", () => {
    const transport = structuredTransport()
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:structured"
        targetPtyId={null}
        agent="claude"
        structuredTransport={transport}
      />
    )

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.openHistory).toHaveBeenCalledWith({
      workspace: { worktreeId: 'wt-structured' },
      initialQuery: ''
    })
    expect(transport.send).not.toHaveBeenCalled()
    expect(transport.dispatchCommand).not.toHaveBeenCalled()
  })

  it('opens history when Enter or a click accepts the leading /resume row', () => {
    mocks.draft = '/res'
    renderTerminalChat({})

    act(() => mocks.keyDownArgs?.dispatchPickerCommand(RESUME))
    // Consuming resets the caret, so the click gets a fresh composer.
    cleanup()
    renderTerminalChat({})
    act(() => mocks.fieldProps?.onChoosePickerItem?.(RESUME))

    expect(mocks.openHistory).toHaveBeenCalledTimes(2)
    expect(mocks.openHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialQuery: '' })
    )
    expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('keeps Tab and mid-prompt picks as ordinary completion', () => {
    mocks.draft = '/res'
    renderTerminalChat({})
    act(() => mocks.keyDownArgs?.completePickerItem(RESUME))
    expect(mocks.setDraft).toHaveBeenLastCalledWith('/resume ')

    cleanup()
    mocks.draft = 'then /res'
    renderTerminalChat({})
    act(() => mocks.fieldProps?.onChoosePickerItem?.(RESUME))
    expect(mocks.setDraft).toHaveBeenLastCalledWith('then /resume ')
    expect(mocks.openHistory).not.toHaveBeenCalled()
  })

  it('leaves other commands on their usual path', () => {
    mocks.draft = '/status'
    renderTerminalChat({})
    act(() => mocks.fieldProps?.onSend?.())
    expect(mocks.openHistory).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatTypedCommand).toHaveBeenCalledWith('pty-1', '/status')
  })

  it("still keeps /resume from the agent when the chat's workspace is not loaded", () => {
    mocks.workspaceLoaded = false
    renderTerminalChat({})

    act(() => mocks.fieldProps?.onSend?.())

    expect(mocks.openHistory).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    // The draft stays so trying again is one keystroke.
    expect(mocks.setDraft).not.toHaveBeenCalled()
    expect(mocks.fieldProps?.notices?.map((notice) => notice.text)).toEqual([
      "This chat's workspace isn't loaded yet. Try /resume again in a moment."
    ])
  })
})
