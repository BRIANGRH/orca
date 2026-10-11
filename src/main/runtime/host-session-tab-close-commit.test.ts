import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import {
  ACK_LEAF,
  ACK_SECOND_LEAF,
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeNotifier } from './runtime-notifier-contract'

/** Proven whole-tab closes remove canonical membership; unproven terminals keep projection protection. */

const WORKTREE = 'repo1::/tmp/worktree'
const CLIENT = 'phone-a'

const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  vi.restoreAllMocks()
})

function terminalFixture() {
  const fixture = createAcknowledgedTabRetirementFixture(true)
  fixtures.push(fixture)
  return fixture
}

function notifier(overrides: Partial<RuntimeNotifier>): RuntimeNotifier {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    ...overrides
  }
}

function recordFrames(runtime: OrcaRuntimeService): RuntimeMobileSessionTabsResult[] {
  const frames: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((frame) => frames.push(frame), CLIENT)
  return frames
}

function ackTabIds(result: RuntimeMobileSessionTabsResult): string[] {
  return result.tabs.flatMap((tab) =>
    tab.type === 'terminal' && tab.parentTabId === ACK_TAB ? [tab.id] : []
  )
}

const browserTab: RuntimeMobileSessionSnapshotTab = {
  type: 'browser',
  id: 'browser-1',
  title: 'Browser',
  browserWorkspaceId: 'browser-workspace-1',
  browserPageId: 'browser-page-1',
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

const editorTab: RuntimeMobileSessionSnapshotTab = {
  type: 'markdown',
  id: 'editor-1',
  title: 'README.md',
  filePath: '/tmp/worktree/README.md',
  relativePath: 'README.md',
  language: 'markdown',
  mode: 'edit',
  isDirty: false,
  isActive: false,
  sourceFileId: 'file-1',
  sourceFilePath: '/tmp/worktree/README.md',
  sourceRelativePath: 'README.md',
  documentVersion: '1'
}

function windowHost(closeSessionTab: RuntimeNotifier['closeSessionTab']): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.setNotifier(notifier({ closeSessionTab }))
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKTREE,
        publicationEpoch: 'renderer:1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: browserTab.id,
        activeTabType: 'browser',
        tabGroups: [
          { id: 'group-1', activeTabId: browserTab.id, tabOrder: [browserTab.id, editorTab.id] }
        ],
        tabs: [browserTab, editorTab]
      }
    ]
  })
  return runtime
}

describe('a window-owned terminal tab closed through the acknowledged relay', () => {
  it('leaves the host list at commit, carrying a retirement proof for every surface', async () => {
    const f = terminalFixture()
    // Why list first: projecting a surface issues the terminal handle a proof names.
    expect(ackTabIds(await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT))).toEqual([
      `${ACK_TAB}::${ACK_LEAF}`,
      `${ACK_TAB}::${ACK_SECOND_LEAF}`
    ])
    const epoch = f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)?.publicationEpoch
    const frames = recordFrames(f.runtime)
    const pending = f.close()
    await f.entered.promise
    f.acknowledgement.resolve()

    await expect(pending).resolves.toEqual({ closed: true })
    // Why the same epoch: a close is not a handover, and a fresh one would fence the window's next frame.
    expect(f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)?.publicationEpoch).toBe(epoch)
    const listed = await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)
    expect(ackTabIds(listed)).toEqual([])
    expect(listed.retiredTerminalSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentTabId: ACK_TAB, leafId: ACK_LEAF, ptyId: 'pty-a' }),
        expect.objectContaining({ parentTabId: ACK_TAB, leafId: ACK_SECOND_LEAF, ptyId: 'pty-b' })
      ])
    )
    expect(
      f.runtime['clientSessionTabSelections']['statesByClient'].get(CLIENT)?.get(ACK_WORKTREE)
    ).toMatchObject({ closedTabIds: new Set() })
    const retirementFrame = frames.at(-1)
    expect(retirementFrame && ackTabIds(retirementFrame)).toEqual([])
    expect(retirementFrame?.retiredTerminalSurfaces).toHaveLength(2)
  })

  it('uses proofs captured before the relay, since the window kills the PTYs during it', async () => {
    const f = terminalFixture()
    await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)
    f.closeTerminalTab.mockImplementationOnce(async () => {
      // The window's close takes the PTYs down, so nothing after the relay can prove them.
      f.runtime['ptysById'].delete('pty-a')
      f.runtime['ptysById'].delete('pty-b')
      f.entered.resolve()
      await f.acknowledgement.promise
    })
    const pending = f.close()
    await f.entered.promise
    f.acknowledgement.resolve()

    await expect(pending).resolves.toEqual({ closed: true })
    const listed = await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)
    expect(ackTabIds(listed)).toEqual([])
    expect(listed.retiredTerminalSurfaces).toHaveLength(2)
  })

  it('stays listed when a surface has no proof, for the window to drop', async () => {
    const f = terminalFixture()
    // No projection has issued a terminal handle, so no surface can carry a proof.
    const pending = f.close()
    await f.entered.promise
    f.acknowledgement.resolve()

    await expect(pending).resolves.toEqual({ closed: true })
    expect(f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)?.tabs).toHaveLength(2)
  })

  it('retires no pane of a split when only one of them has a proof', async () => {
    const f = terminalFixture()
    await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)
    // The second pane's PTY is already gone, so it has nothing to prove its retirement with.
    f.runtime['ptysById'].delete('pty-b')
    const pending = f.close()
    await f.entered.promise
    f.acknowledgement.resolve()

    await expect(pending).resolves.toEqual({ closed: true })
    const stored = f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)
    expect(stored?.tabs.map((tab) => tab.id)).toEqual([
      `${ACK_TAB}::${ACK_LEAF}`,
      `${ACK_TAB}::${ACK_SECOND_LEAF}`
    ])
    expect(stored?.retiredTerminalSurfaces ?? []).toEqual([])
  })

  it('still ships the proofs when the window dropped the tab before acknowledging', async () => {
    const f = terminalFixture()
    await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)
    const frames = recordFrames(f.runtime)
    const pending = f.close()
    await f.entered.promise
    f.publish(false, 2)
    expect(
      f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)?.retiredTerminalSurfaces
    ).toBeUndefined()
    f.acknowledgement.resolve()

    await expect(pending).resolves.toEqual({ closed: true })
    const proofs = expect.arrayContaining([
      expect.objectContaining({ parentTabId: ACK_TAB, leafId: ACK_LEAF, ptyId: 'pty-a' }),
      expect.objectContaining({ parentTabId: ACK_TAB, leafId: ACK_SECOND_LEAF, ptyId: 'pty-b' })
    ])
    expect(
      f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)?.retiredTerminalSurfaces
    ).toEqual(proofs)
    expect(frames.at(-1)?.retiredTerminalSurfaces).toEqual(proofs)
  })

  it('retires nothing when the close is refused as a stale terminal', async () => {
    const f = terminalFixture()
    await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)
    const pending = f.close()
    await f.entered.promise
    f.runtime.onPtySpawned('pty-a', '66666666-6666-4666-8666-666666666666')
    f.acknowledgement.resolve()

    await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(ackTabIds(await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT))).toEqual([
      `${ACK_TAB}::${ACK_LEAF}`,
      `${ACK_TAB}::${ACK_SECOND_LEAF}`
    ])
  })
})

describe('a relayed browser or editor tab', () => {
  it.each([
    ['browser', browserTab.id],
    ['browser by workspace id', 'browser-workspace-1'],
    ['editor', editorTab.id]
  ])('leaves the host list once the window closes the %s tab', async (_kind, closeId) => {
    const closeSessionTab = vi.fn(async () => undefined)
    const runtime = windowHost(closeSessionTab)
    await runtime.listMobileSessionTabs(`id:${WORKTREE}`, CLIENT)
    const frames = recordFrames(runtime)
    const closedId = closeId === editorTab.id ? editorTab.id : browserTab.id

    await expect(runtime.closeMobileSessionTab(`id:${WORKTREE}`, closeId)).resolves.toEqual({
      closed: true
    })

    expect(closeSessionTab).toHaveBeenCalledWith(closedId, WORKTREE)
    // Why the stored list: a browser tab with no live page is listed but never projected.
    const stored = runtime['mobileSessionTabsByWorktree'].get(WORKTREE)
    expect(stored?.tabs.map((tab) => tab.id)).toEqual(
      [browserTab.id, editorTab.id].filter((id) => id !== closedId)
    )
    expect(stored?.tabGroups?.flatMap((group) => group.tabOrder)).not.toContain(closedId)
    expect(stored?.publicationEpoch).toBe('renderer:1')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.tabs.map((tab) => tab.id)).not.toContain(closedId)
  })

  it("keeps a bystander client's projected version monotonic across the close", async () => {
    const runtime = windowHost(vi.fn(async () => undefined))
    const bystander = 'phone-b'
    const before = await runtime.listMobileSessionTabs(`id:${WORKTREE}`, bystander)
    const versions: number[] = []
    runtime.onMobileSessionTabsChanged((frame) => versions.push(frame.snapshotVersion), bystander)

    await runtime.closeMobileSessionTab(`id:${WORKTREE}`, browserTab.id)
    const after = await runtime.listMobileSessionTabs(`id:${WORKTREE}`, bystander)

    // The bystander is on the editor (a browser with no live page is never projected).
    expect(before.activeTabId).toBe(editorTab.id)
    expect(after.activeTabId).toBe(editorTab.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toBeGreaterThan(before.snapshotVersion)
    expect(after.snapshotVersion).toBeGreaterThanOrEqual(versions[0] ?? Infinity)
  })

  it('stays listed when the window declines the close', async () => {
    const closeSessionTab = vi.fn(async () => {
      throw new Error('session_tab_close_canceled')
    })
    const runtime = windowHost(closeSessionTab)

    await expect(runtime.closeMobileSessionTab(`id:${WORKTREE}`, browserTab.id)).rejects.toThrow(
      'session_tab_close_canceled'
    )

    expect(runtime['mobileSessionTabsByWorktree'].get(WORKTREE)?.tabs).toHaveLength(2)
  })

  it('needs no per-client filter: a later host frame that lists the tab again shows it', async () => {
    const runtime = windowHost(vi.fn(async () => undefined))
    await runtime.listMobileSessionTabs(`id:${WORKTREE}`, CLIENT)

    await runtime.closeMobileSessionTab(`id:${WORKTREE}`, editorTab.id)

    expect(
      runtime['clientSessionTabSelections']['statesByClient'].get(CLIENT)?.get(WORKTREE)
    ).toMatchObject({ closedTabIds: new Set() })
    // A reopen of the same id is the host's truth, not a stale frame to hide.
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE,
          publicationEpoch: 'renderer:1',
          snapshotVersion: 3,
          activeGroupId: 'group-1',
          activeTabId: editorTab.id,
          activeTabType: 'markdown',
          tabs: [{ ...editorTab, isActive: true }]
        }
      ]
    })
    const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE}`, CLIENT)
    expect(listed.tabs.map((tab) => tab.id)).toEqual([editorTab.id])
  })
})

describe('closes that do not commit on the host', () => {
  it('a delegated close leaves the host list and every client selection alone', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier(notifier({ closeTerminal }))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: 'host-tab', worktreeId: WORKTREE, title: 'T', activeLeafId: null, layout: null }
      ],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE,
          publicationEpoch: 'renderer:1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'host-tab::leaf',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'host-tab::leaf',
              parentTabId: 'host-tab',
              leafId: 'leaf',
              title: 'T',
              isActive: true
            }
          ]
        }
      ]
    })
    await runtime.listMobileSessionTabs(`id:${WORKTREE}`, CLIENT)
    const stored = runtime['mobileSessionTabsByWorktree'].get(WORKTREE)
    const forgetTabs = vi.spyOn(runtime['clientSessionTabSelections'], 'forgetTabs')

    await expect(runtime.closeMobileSessionTab(`id:${WORKTREE}`, 'host-tab')).resolves.toEqual({
      closed: true
    })

    expect(closeTerminal).toHaveBeenCalledWith('host-tab')
    expect(forgetTabs).not.toHaveBeenCalled()
    expect(runtime['mobileSessionTabsByWorktree'].get(WORKTREE)).toBe(stored)
  })
})

describe('a window-owned pane closed from a client', () => {
  it('is hidden from every client until the window republishes without it', async () => {
    const f = terminalFixture()
    const paneId = `${ACK_TAB}::${ACK_SECOND_LEAF}`
    await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT)

    await expect(
      f.runtime.closeMobileSessionTab(`id:${ACK_WORKTREE}`, paneId, { reason: 'user' })
    ).resolves.toEqual({ closed: true })

    // The host list keeps the pane: the window drops it on an unacknowledged notice.
    expect(
      f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)?.tabs.map((tab) => tab.id)
    ).toContain(paneId)
    expect(ackTabIds(await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, CLIENT))).toEqual([
      `${ACK_TAB}::${ACK_LEAF}`
    ])
  })
})
