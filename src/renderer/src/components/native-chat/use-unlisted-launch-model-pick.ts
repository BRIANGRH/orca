import { useEffect, useRef } from 'react'
import type { StructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import { seedOnHostListedModel } from '../../../../shared/structured-agent-session-option-view'

/** Once per new chat, picks the model the picker shows in place of a remembered one the host's
 *  loaded list lacks, so the first send runs it rather than failing. Picking it also replaces the
 *  remembered selection, as any pick does. */
export function useUnlistedLaunchModelPick(args: {
  sessionId: string
  optionState: StructuredAgentSessionOptionState
  launchSeed: Readonly<Record<string, string>> | undefined
  held: Readonly<Record<string, string>>
  acceptsPicks: boolean
  setStructuredOption: (id: string, value: string) => Promise<boolean>
}): void {
  const { sessionId, optionState, launchSeed, held, acceptsPicks, setStructuredOption } = args
  const replacement =
    optionState.record.model === undefined
      ? seedOnHostListedModel(optionState, launchSeed, held)
      : launchSeed
  const model = replacement !== launchSeed ? replacement?.model : undefined
  const effort = replacement?.effort !== launchSeed?.effort ? replacement?.effort : undefined
  const pickedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!model || !acceptsPicks || pickedFor.current === sessionId) {
      return
    }
    pickedFor.current = sessionId
    void setStructuredOption('model', model).then((picked) =>
      picked && effort ? setStructuredOption('effort', effort) : false
    )
  }, [acceptsPicks, effort, model, sessionId, setStructuredOption])
}
