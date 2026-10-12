import { useCallback } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionListedPicks } from '../../../../shared/structured-agent-session-option-view'

/** The step before a send that moves the chat off a model the host's list no longer offers, to
 *  what the picker shows, through the picker's own pick path; undefined when nothing needs moving. */
export function useListedModelSendPrepare(args: {
  optionState: StructuredAgentSessionOptionState
  launchSeed: Readonly<Record<string, string>> | undefined
  held: Readonly<Record<string, string>>
  listed: AgentSessionModelCatalogResult | null
  setStructuredOption: (id: string, value: string) => Promise<boolean>
}): (() => Promise<void>) | undefined {
  const { optionState, launchSeed, held, listed, setStructuredOption } = args
  const picks = structuredAgentSessionListedPicks(optionState, launchSeed, held, listed)
  const model = picks?.model
  const effort = picks?.effort
  const prepare = useCallback(async () => {
    // Model first, so the effort lands under the model it was resolved for.
    if (model && (await setStructuredOption('model', model)) && effort) {
      await setStructuredOption('effort', effort)
    }
  }, [effort, model, setStructuredOption])
  return model ? prepare : undefined
}
