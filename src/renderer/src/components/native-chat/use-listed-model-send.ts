import { useCallback, type RefObject } from 'react'
import type { StructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionListedPicks } from '../../../../shared/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'

/** Before a send, picks what the picker shows for a model the verified list lacks. Decided from
 *  the chat's state when the send goes, so one behind a send that already moved it picks nothing. */
export function useListedModelSend(
  optionStateRef: RefObject<StructuredAgentSessionOptionState>,
  launch: StructuredAgentSessionLaunchView | undefined,
  sessionId: string,
  setStructuredOption: (id: string, value: string) => Promise<boolean>
): () => Promise<void> {
  return useCallback(async () => {
    const selection = getStructuredAgentSessionLaunchSelection(sessionId)
    const picks = structuredAgentSessionListedPicks(
      optionStateRef.current,
      selection?.seed ?? launch?.seedOptions,
      selection?.held ?? launch?.heldOptions ?? {}
    )
    // Model first, so the effort lands under it.
    if (picks?.model && (await setStructuredOption('model', picks.model)) && picks.effort) {
      await setStructuredOption('effort', picks.effort)
    }
  }, [launch, optionStateRef, sessionId, setStructuredOption])
}
