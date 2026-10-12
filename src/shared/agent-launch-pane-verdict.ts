/**
 * What a pane an `agent.launch` laid out before its agent existed does instead of starting a shell.
 * Main derives it on the pane's spawn and sends it to the window as a typed value; the spawn itself
 * only fails with `AGENT_LAUNCH_PANE_REFUSED_CODE`, so nothing is parsed out of error text.
 */

/** Why a launch pane shows no agent: the launch failed before its agent ran; `code` is the reason,
 *  for the window to word. Kept on the tab for this session only. */
export type AgentLaunchPaneOutcome = { kind: 'not-started'; code: string }

export type AgentLaunchPaneVerdict =
  /** No launch owns the pane, or its agent runs or ran there: the pane's own spawn decides. */
  | { kind: 'proceed' }
  | AgentLaunchPaneOutcome
  /** The launch ran elsewhere or never ran; the host takes the pane back. */
  | { kind: 'withdrawn' }

/** The one error a refused launch pane's spawn fails with; the window shows the verdict instead. */
export const AGENT_LAUNCH_PANE_REFUSED_CODE = 'agent_launch_pane_refused'

/** The pane a verdict is about, as the window addresses it. */
export type AgentLaunchPaneAddress = { worktreeId: string; tabId: string; leafId: string }

export type AgentLaunchPaneVerdictEvent = AgentLaunchPaneAddress & {
  verdict: AgentLaunchPaneVerdict
}

/** A launch pane as the window saves it: only a pending one, since its outcome is this session's. */
export function pendingAgentLaunchPane<T extends { outcome?: unknown }>(
  pane: T
): Omit<T, 'outcome'> {
  const { outcome: _outcome, ...pending } = pane
  void _outcome
  return pending
}
