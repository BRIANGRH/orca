import type { Project } from './project-types'
import type { Repo } from './repo-types'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from './folder-workspace-execution-host'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  getWorkspaceRuntimePreference,
  resolveProjectExecutionRuntime,
  type LegacyWindowsRuntimeSettings,
  type ProjectExecutionRuntimeResolution
} from './project-execution-runtime'

/** The one local repo whose project runs a folder workspace on this machine; none for a folder
 *  pinned to another host or spanning several repos. */
export function findLocalFolderWorkspaceRuntimeRepo(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string
): Repo | undefined {
  const folder = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!folder || resolveFolderWorkspaceHost(state, folder.id).kind !== 'local') {
    return undefined
  }
  const group = state.projectGroups.find((entry) => entry.id === folder.projectGroupId)
  if (
    (folder.executionHostId ?? group?.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !==
    LOCAL_EXECUTION_HOST_ID
  ) {
    return undefined
  }
  const candidates = findFolderWorkspaceCandidateRepos(state, folder.id)
  const repo = candidates.length === 1 ? candidates[0] : undefined
  return repo && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID ? repo : undefined
}

/**
 * A local repo workspace's runtime, read the same way by the window and the host: its project's
 * saved runtime, else the distro of a WSL-share path, else the global default.
 */
export function resolveLocalWorkspaceExecutionRuntime(args: {
  appPlatform: NodeJS.Platform
  projects:
    | readonly Pick<Project, 'id' | 'sourceRepoIds' | 'localWindowsRuntimePreference'>[]
    | undefined
  settings:
    | (LegacyWindowsRuntimeSettings & { localWindowsRuntimeDefault?: unknown })
    | null
    | undefined
  repoId: string
  /** The workspace's own project; absent looks the project up by repo. */
  projectId?: string
  workspacePath: string | null | undefined
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}): ProjectExecutionRuntimeResolution {
  const project = args.projects?.find(
    (entry) =>
      entry.id === args.projectId ||
      entry.id === args.repoId ||
      entry.sourceRepoIds?.includes(args.repoId)
  )
  return resolveProjectExecutionRuntime({
    appPlatform: args.appPlatform,
    projectId: args.projectId ?? project?.id ?? args.repoId,
    projectRuntimePreference: getWorkspaceRuntimePreference(
      project?.localWindowsRuntimePreference,
      args.workspacePath
    ),
    globalWindowsRuntimeDefault:
      args.settings?.localWindowsRuntimeDefault ??
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(args.settings).defaultRuntime,
    wslAvailable: args.wslAvailable,
    availableWslDistros: args.availableWslDistros
  })
}
