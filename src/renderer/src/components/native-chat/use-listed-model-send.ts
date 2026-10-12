import { useCallback } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionListedPicks } from '../../../../shared/structured-agent-session-option-view'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'

/** Before a send, picks what the picker shows for a model the host's list lacks; else undefined. */
export function useListedModelSend(
  optionState: StructuredAgentSessionOptionState,
  launch: StructuredAgentSessionLaunchView | undefined,
  listed: AgentSessionModelCatalogResult | null,
  setStructuredOption: (id: string, value: string) => Promise<boolean>
): (() => Promise<void>) | undefined {
  const held = launch?.heldOptions ?? {}
  const picks = structuredAgentSessionListedPicks(optionState, launch?.seedOptions, held, listed)
  const model = picks?.model
  const effort = picks?.effort
  const prepare = useCallback(async () => {
    // Model first, so the effort lands under it.
    if (model && (await setStructuredOption('model', model)) && effort) {
      await setStructuredOption('effort', effort)
    }
  }, [effort, model, setStructuredOption])
  return model ? prepare : undefined
}
