import type { Store } from './persistence'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Project } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import {
  findLocalFolderWorkspaceRuntimeRepo,
  resolveLocalWorkspaceExecutionRuntime
} from '../shared/local-workspace-execution-runtime'
import {
  resolveProjectExecutionRuntime,
  type ProjectExecutionRuntimeResolution
} from '../shared/project-execution-runtime'
import {
  getCachedWslAvailability,
  getCachedWslDistros,
  hasCachedWslAvailability,
  hasCachedWslDistros
} from './wsl'
import { getRepoIdFromWorktreeId } from '../shared/worktree/id'
import { resolveLocalPtyRuntimeOptions } from '../shared/agent-launch-runtime'
import type { LocalWindowsTerminalRuntimeOptions } from '../shared/local-windows-terminal-runtime'
import { resolveManagedSshHostLoginShell } from './pty/managed-ssh-host-login-shell'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'

/**
 * The slice of the store runtime resolution actually reads. Structural rather
 * than the full `Store` so narrowed stores -- the Orca runtime's `RuntimeStore`,
 * worktree root preparation -- resolve the same runtime the create path does
 * instead of silently falling back to host placement.
 *
 * Members stay optional because those stores declare them optional; the
 * `typeof` guards below are what actually decide whether resolution can run.
 */
export type ProjectRuntimeResolutionStore = {
  getProjects?: Store['getProjects']
  getRepo?: Store['getRepo']
  getSettings?: () => Partial<Pick<GlobalSettings, 'localWindowsRuntimeDefault'>>
}

type ResolvableStore = ProjectRuntimeResolutionStore & {
  getProjects: NonNullable<ProjectRuntimeResolutionStore['getProjects']>
  getSettings: NonNullable<ProjectRuntimeResolutionStore['getSettings']>
}

function canResolveProjectRuntimeForRepo(
  store: ProjectRuntimeResolutionStore
): store is ResolvableStore {
  return typeof store.getProjects === 'function' && typeof store.getSettings === 'function'
}

function canResolveProjectRuntimeForWorktreeId(
  store: ProjectRuntimeResolutionStore
): store is ResolvableStore & { getRepo: NonNullable<ProjectRuntimeResolutionStore['getRepo']> } {
  return canResolveProjectRuntimeForRepo(store) && typeof store.getRepo === 'function'
}

function resolveLocalProjectRuntime(
  store: ResolvableStore,
  project: Pick<Project, 'id' | 'localWindowsRuntimePreference'>,
  settings: ReturnType<ResolvableStore['getSettings']> = store.getSettings()
): ProjectExecutionRuntimeResolution {
  return resolveProjectExecutionRuntime({
    appPlatform: process.platform,
    projectId: project.id,
    projectRuntimePreference: project.localWindowsRuntimePreference,
    globalWindowsRuntimeDefault: settings.localWindowsRuntimeDefault,
    ...cachedWslFacts()
  })
}

function cachedWslFacts(): {
  wslAvailable?: boolean
  availableWslDistros: readonly string[] | null
} {
  return {
    wslAvailable: hasCachedWslAvailability()
      ? (getCachedWslAvailability() ?? undefined)
      : undefined,
    availableWslDistros: hasCachedWslDistros() ? getCachedWslDistros() : null
  }
}

export function resolveLocalProjectRuntimeForRepo(
  store: ProjectRuntimeResolutionStore,
  repo: Repo
): ProjectExecutionRuntimeResolution | undefined {
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    !canResolveProjectRuntimeForRepo(store)
  ) {
    return undefined
  }
  const project = store.getProjects().find((entry) => entry.sourceRepoIds.includes(repo.id))
  if (!project) {
    return undefined
  }
  return resolveLocalProjectRuntime(store, project)
}

/** The window's runtime for a repo workspace (`resolveLocalWorkspaceExecutionRuntime`), read from
 *  main's store and WSL caches. Works for a repo with no project too. */
export function resolveLocalWorkspaceRuntime(
  store: ProjectRuntimeResolutionStore,
  repo: Repo,
  workspacePath: string | null | undefined
): ProjectExecutionRuntimeResolution | undefined {
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    !canResolveProjectRuntimeForRepo(store)
  ) {
    return undefined
  }
  return resolveLocalWorkspaceExecutionRuntime({
    appPlatform: process.platform,
    projects: store.getProjects(),
    settings: store.getSettings(),
    repoId: repo.id,
    workspacePath,
    ...cachedWslFacts()
  })
}

export type LaunchScopeRuntimeStore = ProjectRuntimeResolutionStore & {
  getRepos?: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getProjectGroups?: () => ProjectGroup[]
}

/** The window's runtime for a workspace (`getLocalProjectExecutionRuntimeContext`), for a launch
 *  scope this host resolved. A remote scope has none: its host plans for itself. */
export function resolveLocalLaunchScopeRuntime(
  store: LaunchScopeRuntimeStore,
  scope: {
    id: string
    path: string
    connectionId: string | null
    repo: Repo | null
    folderWorkspace: Pick<FolderWorkspace, 'id'> | null
  }
): ProjectExecutionRuntimeResolution | undefined {
  if (scope.connectionId) {
    return undefined
  }
  const repo =
    scope.repo ??
    (scope.folderWorkspace
      ? findLocalFolderWorkspaceRuntimeRepo(
          {
            folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
            projectGroups: store.getProjectGroups?.() ?? [],
            repos: store.getRepos?.() ?? []
          },
          scope.folderWorkspace.id
        )
      : undefined)
  // A repo-less folder has no runtime: its path alone places it, and its cwd picks its shell.
  return repo ? resolveLocalWorkspaceRuntime(store, repo, scope.path) : undefined
}

export function resolveLocalProjectRuntimesForRepos(
  store: ProjectRuntimeResolutionStore,
  repos: readonly Repo[]
): ReadonlyMap<string, ProjectExecutionRuntimeResolution> {
  const runtimeByRepoId = new Map<string, ProjectExecutionRuntimeResolution>()
  if (!canResolveProjectRuntimeForRepo(store)) {
    return runtimeByRepoId
  }
  const requestedRepoIds = new Set(
    repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => repo.id)
  )
  if (requestedRepoIds.size === 0) {
    return runtimeByRepoId
  }
  const settings = store.getSettings()
  for (const project of store.getProjects()) {
    const matchingRepoIds = project.sourceRepoIds.filter(
      (repoId) => requestedRepoIds.has(repoId) && !runtimeByRepoId.has(repoId)
    )
    if (matchingRepoIds.length === 0) {
      continue
    }
    // Why: one project runtime applies to every source repo in that project;
    // resolving it once prevents mobile polls from rescanning project settings.
    const runtime = resolveLocalProjectRuntime(store, project, settings)
    for (const repoId of matchingRepoIds) {
      runtimeByRepoId.set(repoId, runtime)
    }
  }
  return runtimeByRepoId
}

export function resolveLocalProjectRuntimeForWorktreeId(
  store: ProjectRuntimeResolutionStore | undefined,
  worktreeId: string | undefined
): ProjectExecutionRuntimeResolution | undefined {
  if (!store || !worktreeId) {
    return undefined
  }
  if (!canResolveProjectRuntimeForWorktreeId(store)) {
    return undefined
  }
  const repo = store.getRepo(getRepoIdFromWorktreeId(worktreeId))
  return repo ? resolveLocalProjectRuntimeForRepo(store, repo) : undefined
}

/** A plain terminal's PTY on this host: the spawn's rule when no agent plan brought its own. */
export function resolvePlainTerminalPtyOptions(
  store: ProjectRuntimeResolutionStore | undefined,
  settings: Parameters<typeof resolveLocalPtyRuntimeOptions>[0]['settings'],
  worktreeId: string | undefined,
  requestedShellOverride: string | undefined
): LocalWindowsTerminalRuntimeOptions {
  return resolveLocalPtyRuntimeOptions({
    hostPlatform: process.platform,
    requestedShellOverride,
    settings,
    projectRuntime: resolveLocalProjectRuntimeForWorktreeId(store, worktreeId),
    fallbackHostShell: process.env.COMSPEC || 'powershell.exe',
    sshLoginShell: resolveManagedSshHostLoginShell()
  })
}
