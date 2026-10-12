import { afterEach, describe, expect, it } from 'vitest'
import {
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests,
  resolveAgentLaunchPaneVerdict,
  trackRunningAgentLaunchPane
} from './agent-launch-pane-attachment'

const PANE = { worktreeId: 'wt-1', paneKey: 'tab-1:leaf-1' }
const notLive = (): boolean => false

describe('a pane an agent launch laid out', () => {
  afterEach(() => {
    resetAgentLaunchPanesForTests()
  })

  it('is an ordinary pane when no launch runs for it, as after a restart', () => {
    expect(resolveAgentLaunchPaneVerdict(PANE, notLive)).toBeNull()
  })

  it('waits for the launch running in this process, then says how it ended', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const verdict = resolveAgentLaunchPaneVerdict(PANE, notLive)
    expect(verdict).not.toBeNull()

    running.finish({ kind: 'not-started', code: 'agent_session_exited_during_start' })

    await expect(verdict).resolves.toEqual({
      kind: 'not-started',
      code: 'agent_session_exited_during_start'
    })
    // Over: the next spawn of this pane is an ordinary one.
    expect(resolveAgentLaunchPaneVerdict(PANE, notLive)).toBeNull()
  })

  it("hears the user's close only while the pane's launch is running", () => {
    const tabId = 'tab-closing'
    const leafId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId })
    const running = trackRunningAgentLaunchPane({
      worktreeId: 'wt-1',
      paneKey: `${tabId}:${leafId}`
    })
    expect(running.closedByUser()).toBe(false)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'tab', tabId: 'tab-other' })
    markAgentLaunchesClosedByUser('wt-1', {
      kind: 'pane',
      tabId,
      leafId: '6fa459ea-ee8a-4ca4-894e-db77e160355e'
    })
    expect(running.closedByUser()).toBe(false)
    markAgentLaunchesClosedByUser('wt-1', { kind: 'pane', tabId, leafId })
    expect(running.closedByUser()).toBe(true)
  })

  it('never offers a shell in a tab the host is taking back', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const verdict = resolveAgentLaunchPaneVerdict(PANE, notLive)
    running.finish({ kind: 'withdrawn' })
    await expect(verdict).resolves.toEqual({ kind: 'withdrawn' })
  })

  it('attaches to a process that holds the pane, whatever the launch says', async () => {
    const running = trackRunningAgentLaunchPane(PANE)
    const verdict = resolveAgentLaunchPaneVerdict(PANE, () => true)
    running.finish({ kind: 'not-started', code: 'boom' })
    await expect(verdict).resolves.toEqual({ kind: 'proceed' })
  })
})
