import { expect, it } from 'vitest'
import type { ProjectExecutionRuntimeRepair } from './project-execution-runtime'
import {
  agentLaunchRepairRefusal,
  projectRuntimeRepairSentence
} from './project-runtime-repair-message'

const repair = (
  fields: Pick<ProjectExecutionRuntimeRepair, 'reason' | 'source'>
): ProjectExecutionRuntimeRepair => ({
  projectId: 'p',
  preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
  cacheKey: 'k',
  ...fields
})

it("words each repair under the project settings page's key, in the caller's language", () => {
  const reasons = ['wsl-unavailable', 'wsl-distro-missing', 'wsl-distro-required'] as const
  const keys = reasons.map((reason) =>
    projectRuntimeRepairSentence(repair({ reason, source: 'project-override' }), (key, _en, v) =>
      v ? `${key}(${v.value0})` : key
    )
  )
  expect(keys.join(' ')).toBe(
    'auto.components.settings.ProjectWindowsRuntimeSetting.wslUnavailable auto.components.settings.ProjectWindowsRuntimeSetting.distroMissing(Ubuntu) auto.components.settings.ProjectWindowsRuntimeSetting.distroRequired'
  )
  // The host writes English, naming the default when the runtime came from it.
  expect(
    agentLaunchRepairRefusal(repair({ reason: 'wsl-unavailable', source: 'global-default' }))
  ).toBe(
    'No agent was started. WSL is not available. Switch this project to Windows or repair WSL. This project follows the default in Settings > Project Runtime.'
  )
})
