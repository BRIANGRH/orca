import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import {
  ACK_INCARNATION,
  ACK_LEAF,
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'

const clients = ['phone-a', 'old-bystander-phone']
const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  vi.restoreAllMocks()
})

describe('acknowledged terminal closes awaiting complete retirement proofs', () => {
  it.each([{ missingPtyIds: ['pty-b'] }, { missingPtyIds: ['pty-a', 'pty-b'] }])(
    'keeps a committed close hidden from registered clients with missing PTYs $missingPtyIds',
    async ({ missingPtyIds }) => {
      const f = createAcknowledgedTabRetirementFixture(true)
      fixtures.push(f)
      const before = await Promise.all(
        clients.map((client) => f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, client))
      )
      const frames: RuntimeMobileSessionTabsResult[][] = clients.map(() => [])
      for (const [index, client] of clients.entries()) {
        f.runtime.onMobileSessionTabsChanged((frame) => frames[index]?.push(frame), client)
      }
      for (const ptyId of missingPtyIds) {
        f.runtime['ptysById'].delete(ptyId)
      }
      const pending = f.close()
      await f.entered.promise
      f.acknowledgement.resolve()

      await expect(pending).resolves.toEqual({ closed: true })
      const stored = f.runtime['mobileSessionTabsByWorktree'].get(ACK_WORKTREE)
      expect(stored?.tabs).toHaveLength(2)
      expect(stored?.retiredTerminalSurfaces ?? []).toEqual([])

      for (const [index, client] of clients.entries()) {
        const listed = await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, client)
        expect(listed.tabs).toEqual([])
        expect(listed.snapshotVersion).toBeGreaterThan(before[index]?.snapshotVersion ?? Infinity)
      }
      f.runtime['republishMobileSessionTabsSnapshot'](ACK_WORKTREE)
      for (const received of frames) {
        expect(received.at(-1)?.tabs).toEqual([])
      }

      f.publish(false, 2)
      for (const client of clients) {
        await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, client)
        const state = f.runtime['clientSessionTabSelections']['statesByClient']
          .get(client)
          ?.get(ACK_WORKTREE)
        expect(state?.closedTabIds).toEqual(new Set())
      }
      expect(f.hasTab()).toBe(false)
      expect(
        stored?.tabs.every((tab) => tab.type === 'terminal' && tab.parentTabId === ACK_TAB)
      ).toBe(true)
    }
  )

  it('explicitly activates every retained leaf after a whole-parent close', async () => {
    const f = createAcknowledgedTabRetirementFixture(true)
    fixtures.push(f)
    const before = await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, clients[1])
    f.runtime['ptysById'].delete('pty-b')
    const pending = f.close()
    await f.entered.promise
    f.acknowledgement.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    expect((await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, clients[1])).tabs).toEqual(
      []
    )

    const activated = await f.runtime.activateMobileSessionTab(
      `id:${ACK_WORKTREE}`,
      ACK_TAB,
      ACK_LEAF,
      { navigation: 'caller', clientNavigationId: clients[1] }
    )

    expect(activated.tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id))
    expect(activated.activeTabId).toBe(`${ACK_TAB}::${ACK_LEAF}`)
  })

  it('refuses re-adoption of a still-live surface under the committed closed parent', async () => {
    const f = createAcknowledgedTabRetirementFixture(true)
    fixtures.push(f)
    const listed = await f.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`, clients[1])
    const live = listed.tabs.find((tab) => tab.type === 'terminal' && tab.ptyId === 'pty-a')
    if (live?.type !== 'terminal' || !live.terminal) {
      throw new Error('Expected a live terminal handle before closing')
    }
    const terminal = live.terminal
    // The close fixture has no checkout; supply workspace discovery for the public adoption route.
    const git = {
      path: '/tmp/worktree',
      head: 'head',
      branch: 'main',
      isBare: false,
      isMainWorktree: false
    }
    vi.spyOn(f.runtime, 'resolveWorktreeSelector').mockResolvedValue({
      ...git,
      id: ACK_WORKTREE,
      repoId: 'repo1',
      displayName: 'Fixture',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git
    })
    f.runtime['ptysById'].delete('pty-b')
    const pending = f.close()
    await f.entered.promise
    f.acknowledgement.resolve()
    await expect(pending).resolves.toEqual({ closed: true })

    f.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-a',
          worktreeId: ACK_WORKTREE,
          cwd: '/tmp/worktree',
          title: 'Still live',
          terminalHandle: terminal,
          incarnationId: ACK_INCARNATION,
          wslDistro: null
        }
      ]
    })

    await expect(
      f.runtime.adoptTerminalOrphans({
        worktree: `id:${ACK_WORKTREE}`,
        expectedTopologyRevision: f.runtime['getTerminalTopologyRevision'](ACK_WORKTREE),
        claims: [
          {
            terminal,
            ptyId: 'pty-a',
            incarnationId: ACK_INCARNATION,
            tabId: ACK_TAB,
            leafId: ACK_LEAF
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_surface_retired')
    expect(f.runtime['ptysById'].get('pty-a')?.connected).toBe(true)
    expect(f.hasTab()).toBe(false)
  })
})
