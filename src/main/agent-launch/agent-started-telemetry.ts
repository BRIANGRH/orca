/**
 * The `agent_started` triple for an agent launch the host builds; `launch_source` and
 * `request_kind` come from the caller.
 *
 * `agent_kind` is derived rather than accepted — a value the host derives is one a caller cannot
 * misreport. `request_kind` is the caller's (a resume or follow-up the host cannot tell from a fresh
 * start), read as leniently as `launch_source`: absent or unknown is `new`.
 *
 * Every launch is attributed: a caller that names no surface, or one this build has never heard of
 * (a newer client), is recorded as `unknown` rather than dropped. The wire keeps the arm set open so
 * an older host cannot refuse a newer client's launch over a label, and resolving it here, leniently,
 * keeps that label from gating the launch at the point it is actually used.
 */

import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { launchSourceSchema, requestKindSchema } from '../../shared/telemetry-property-schemas'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'

export function agentStartedTelemetry(
  agent: TuiAgent,
  launchSource: string | undefined,
  requestKind?: string
): NonNullable<WorktreeStartupLaunch['telemetry']> {
  const parsed = launchSourceSchema.safeParse(launchSource)
  const kind = requestKindSchema.safeParse(requestKind)
  return {
    agent_kind: tuiAgentToAgentKind(agent),
    launch_source: parsed.success ? parsed.data : 'unknown',
    request_kind: kind.success ? kind.data : 'new'
  }
}
