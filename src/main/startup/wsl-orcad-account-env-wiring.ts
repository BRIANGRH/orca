import { withClaudeProfileTerminalEnv } from '../claude-accounts/claude-profile-installed-router'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import type { Store } from '../persistence'
import { installWslOrcadAccountEnvDependencies } from '../wsl/wsl-orcad-account-env'
import { mainProcessState as state } from './main-process-state'

/** The desktop's account services behind the WSL orcad accounts shim. */
export function installWslOrcadAccountShim(store: Pick<Store, 'getSettings'>): void {
  installWslOrcadAccountEnvDependencies({
    prepareClaudeLaunch: (target) => {
      const auth = state.claudeRuntimeAuth
      if (!auth) {
        throw new Error('Claude account service is not initialized')
      }
      return auth.prepareForClaudeLaunch(target)
    },
    claudeTerminalEnv: (target) => withClaudeProfileTerminalEnv({}, target),
    prepareCodexHome: async (target) => {
      const runtimeHome = state.codexRuntimeHome
      if (!runtimeHome || !getSelectedCodexAccountIdForTarget(store.getSettings(), target)) {
        return null
      }
      // Why not prepareCodexRuntimeHomeForLaunch: its hook install targets this desktop's relay,
      // while agent status on a WSL host belongs to that host's orcad.
      return runtimeHome.prepareForCodexLaunchAsync(target)
    }
  })
}
