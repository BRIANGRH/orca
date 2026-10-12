// The words for a project runtime that needs repair, under the project settings page's keys. The
// window passes its translator; the host, which runs without Electron's i18n, writes English.
import type { ProjectExecutionRuntimeRepair } from './project-execution-runtime'

/** A launch refused, before any spawn, because its project's runtime needs repair. */
export const PROJECT_RUNTIME_REPAIR_REQUIRED_CODE = 'project_runtime_repair_required'

export type RepairTranslate = (key: string, fallback: string, values?: { value0: string }) => string

export function projectRuntimeRepairSentence(
  repair: ProjectExecutionRuntimeRepair,
  t: RepairTranslate
): string {
  switch (repair.reason) {
    case 'wsl-unavailable':
      return t(
        'auto.components.settings.ProjectWindowsRuntimeSetting.wslUnavailable',
        'WSL is not available. Switch this project to Windows or repair WSL.'
      )
    case 'wsl-distro-missing':
      return t(
        'auto.components.settings.ProjectWindowsRuntimeSetting.distroMissing',
        '{{value0}} is not installed in WSL. Choose an installed distro or switch this project to Windows.',
        { value0: repair.preferredRuntime.distro ?? 'WSL' }
      )
    case 'wsl-distro-required':
      return t(
        'auto.components.settings.ProjectWindowsRuntimeSetting.distroRequired',
        'Choose a WSL distro or switch this project to Windows.'
      )
  }
}

const english: RepairTranslate = (_key, fallback, values) =>
  values ? fallback.replace('{{value0}}', values.value0) : fallback

/** What an agent launch refused for this repair says: what happened, then the settings sentence. */
export function agentLaunchRepairRefusal(repair: ProjectExecutionRuntimeRepair): string {
  const byDefault =
    repair.source === 'global-default'
      ? ' This project follows the default in Settings > Project Runtime.'
      : ''
  return `No agent was started. ${projectRuntimeRepairSentence(repair, english)}${byDefault}`
}
