import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import type {
  StructuredAgentAdapterContext,
  StructuredAgentModelCatalogContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentRuntimeRegistration
} from '../runtime/structured-agent-runtime-registrations'
import { PI_RPC_AGENT } from './rpc-agent-definition'
import {
  createPiRpcLaunchResolver,
  piRpcVersionSupported,
  resolvePiRpcCommand
} from './rpc-launch-resolution'
import { PiRpcSessionAdapter } from './rpc-session-adapter'
import { createPiModelCatalogProbe } from './rpc-model-catalog-probe'

/** The environment every Pi child starts from: a chat's launch and a catalog listing alike. */
function piEnvironment({
  deps,
  environment
}: StructuredAgentModelCatalogContext): () => Promise<NodeJS.ProcessEnv> {
  return async () => ({
    ...(await environment.resolveBaseEnvironment()),
    ...deps.resolveAgentLaunchEnv?.('pi')
  })
}

function createPiRpcAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new PiRpcSessionAdapter({
    resolveLaunch: createPiRpcLaunchResolver({
      store: context.store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: piEnvironment(context),
      refreshEnvironmentAfterMiss: context.environment.refreshAfterMissingProgram,
      ...(deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
        : {})
    }),
    ...(deps.openPiConnection ? { openConnection: deps.openPiConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onLifecycle: context.deliverLifecycle,
    onSettled: ({ sessionId, clientMessageId, outcome }) => {
      if (outcome.state === 'admitted') {
        return
      }
      context.followUps.onDispatchSettledLate({
        sessionId,
        clientMessageId,
        ...(outcome.state === 'accepted' ? { providerIdentity: outcome.providerIdentity } : outcome)
      })
    },
    onIdle: context.followUps.releaseUnansweredDispatches,
    logger: deps.logger
  })
}

export const PI_RPC_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = {
  definition: PI_RPC_AGENT,
  createAdapter: createPiRpcAdapter,
  modelCatalog: (context) => ({
    kind: 'probe',
    // `--list-models` marks no model as the one Pi runs by default.
    listingNamesConfiguredModel: false,
    probe: createPiModelCatalogProbe({
      resolveEnvironment: piEnvironment(context),
      ...(context.deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: context.deps.resolveAgentCommandSettings }
        : {})
    })
  }),
  supportsLocation: supportsSupervisedProviderChildLocation,
  launchCheck: {
    resolveLaunch: (env, commandSettings) => ({
      command: resolvePiRpcCommand(env, commandSettings),
      env
    }),
    supportsVersion: (launch) => piRpcVersionSupported(launch)
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      PI_RPC_AGENT,
      launchEnv.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
    )
}
