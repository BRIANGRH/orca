import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
import {
  collectSessionOwnerKeys,
  sessionPartitions
} from './orcad-source-workspace-session-fragments'
import {
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/** The host partition owns its rows; local can hold an older renderer copy of the same workspace. */
export function orcadMigrationSessionPartitions(
  state: PersistedState,
  scope: OrcadMigrationSourceScope
) {
  const partitions = sessionPartitions(state, LOCAL_EXECUTION_HOST_ID)
  const ownerSession = partitions.find(([hostId]) => hostId === scope.hostId)?.[1]
  if (!ownerSession) {
    return partitions
  }
  const ownerScope = orcadMigrationPartitionScope(scope, scope.hostId)
  const owned = new Set(
    [...collectSessionOwnerKeys(ownerSession)]
      .filter((key) => orcadMigrationOwnerMatchesScope(key, ownerScope))
      .map(unqualifyOrcadMigrationOwnerKey)
  )
  return partitions.map(([hostId, session]) => {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return [hostId, session] as const
    }
    const localScope = orcadMigrationPartitionScope(scope, hostId)
    const fencedOwners = new Set(
      Object.values(session.sleepingAgentSessionsByPaneKey ?? {})
        .filter(
          (record) =>
            'automaticResumeBlockedBy' in record && record.automaticResumeBlockedBy !== undefined
        )
        .map((record) => unqualifyOrcadMigrationOwnerKey(record.worktreeId))
    )
    const spill = new Set(
      [...collectSessionOwnerKeys(session)].filter(
        (key) =>
          orcadMigrationOwnerMatchesScope(key, localScope) &&
          owned.has(unqualifyOrcadMigrationOwnerKey(key)) &&
          !fencedOwners.has(unqualifyOrcadMigrationOwnerKey(key))
      )
    )
    if (spill.size === 0) {
      return [hostId, session] as const
    }
    const next = removeWorkspaceSessionOwners(session, spill)!
    // Owner removal preserves these fences/recency normally; the host's copies own this export.
    for (const key of spill) {
      delete next.terminalTopologyRevisionByRepoId?.[key]
      delete next.lastVisitedAtByWorktreeId?.[key]
    }
    return [hostId, next] as const
  })
}
