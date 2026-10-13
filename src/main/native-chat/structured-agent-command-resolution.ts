import { delimiter, isAbsolute } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  resolveCliCommand,
  resolveExecutableCommand
} from '../../shared/node-cli-command-resolution'
import {
  hasExplicitTuiLaunchCommand,
  structuredAgentCommandToken
} from '../../shared/tui-agent-launch-command-override'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './agent-session-wire/structured-agent-session-adapter'

export type StructuredAgentCommandSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv'>
>
type CommandSettings = StructuredAgentCommandSettings
type CommandOptions = NonNullable<Parameters<typeof resolveExecutableCommand>[1]>

function resolveOverride(
  agent: TuiAgent,
  settings: CommandSettings | null | undefined,
  options: CommandOptions
) {
  const token = structuredAgentCommandToken(settings?.agentCmdOverrides?.[agent] ?? '')
  const overlay = settings?.agentDefaultEnv?.[agent]
  return token
    ? resolveExecutableCommand(token, {
        ...options,
        pathEnv: options.pathEnv ?? overlay?.PATH ?? overlay?.Path
      })
    : null
}

// Windows starts .exe/.com directly and .cmd/.bat through Orca's shim handling; an extensionless
// file would fail to spawn with no word about the setting.
function spawnableOn(platform: NodeJS.Platform, command: string): boolean {
  return platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(command)
}

/** Re-read the existing setting for every session acquisition and catalog probe. A set Command
 *  that names no runnable program refuses the start rather than quietly running the stock CLI.
 *  Without one, `stock` names the agent's own binary (the agent id by default). */
export function resolveStructuredAgentCommand(
  agent: TuiAgent,
  settings: CommandSettings,
  options: CommandOptions = {},
  stock: { command?: string; resolve?: typeof resolveCliCommand } = {}
): string {
  if (!hasExplicitTuiLaunchCommand(settings, agent)) {
    return (stock.resolve ?? resolveCliCommand)(stock.command ?? agent, options)
  }
  const command = resolveOverride(agent, settings, options)
  if (!command || !spawnableOn(options.platform ?? process.platform, command)) {
    // The value stays out of the message: a saved command line can carry a secret.
    throw new AgentSessionPreSpawnError(`the ${agent} Command setting is not a runnable program`, {
      reason: 'agentCommandNotRunnable'
    })
  }
  return command
}

/** Whether a lookup found nothing: a bare name back from a search of absolute directories only. A
 *  relative entry (a workspace `bin`) is searched again by the spawn in its own directory. */
function foundNothing(command: string, searchedPath: string | undefined): boolean {
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    return false
  }
  return (searchedPath ?? '')
    .split(delimiter)
    .every((entry) => isAbsolute(entry.trim()) || !entry.trim())
}

/** Resolves a launch's program from the shell snapshot. When nothing is found there (a bare name
 *  from `searchedPath`, or a Command setting naming no program), waits for a reread that started
 *  after this lookup did and resolves once more, so an agent installed before it starts. A found
 *  program never waits. */
export async function resolveAgainAfterRefreshOnMissingProgram<T extends { command: string }>(
  resolve: () => Promise<T>,
  refreshAfterMiss: ((askedAt: number) => Promise<void>) | undefined,
  searchedPath: (resolved: T) => string | undefined
): Promise<T> {
  if (!refreshAfterMiss) {
    return resolve()
  }
  const askedAt = Date.now()
  try {
    const resolved = await resolve()
    if (!foundNothing(resolved.command, searchedPath(resolved))) {
      return resolved
    }
  } catch (error) {
    if (!isAgentSessionPreSpawnError(error) || error.reason !== 'agentCommandNotRunnable') {
      throw error
    }
  }
  await refreshAfterMiss(askedAt)
  return resolve()
}
