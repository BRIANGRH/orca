import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import { valuesOnListedModel } from './agent-session-unlisted-model'

function catalogListsSeedModel(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>>
): boolean {
  const model = seed.model
  return model === undefined || Boolean(state.catalog?.models.some((entry) => entry.id === model))
}

/**
 * What the picker shows before the host has confirmed this session's values:
 * `seed` (the selection a launch seeds) stands in until the record names a
 * model, and `picked` (held) picks outrank both until the host settles them, as does what a send
 * moves a model `listed` no longer offers to. All show as `dispatched`; derived on every read,
 * never written into the record.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  picked: Readonly<Record<string, string>>,
  listed: AgentSessionModelCatalogResult | null = null
): StructuredAgentSessionOptionState {
  // A model the host's list no longer offers shows as what the next send moves to.
  const replaced = structuredAgentSessionListedPicks(state, seed, picked, listed)
  const held = replaced ? { ...picked, ...replaced } : picked
  const unconfirmedSeed = seed !== undefined && state.record.model === undefined
  const hasHeld = Object.keys(held).length > 0
  // A saved pick the host's list does not name would show its raw id or another model's label.
  if (
    unconfirmedSeed &&
    state.catalogSource === 'host' &&
    !hasHeld &&
    !catalogListsSeedModel(state, seed)
  ) {
    return { ...state, catalogSource: 'seed' }
  }
  // Only a host's or the session's list names a saved pick: a built-in label may be replaced.
  const seeded =
    unconfirmedSeed &&
    (state.catalogSource === 'host' || state.catalogSource === 'live') &&
    catalogListsSeedModel(state, seed)
  if (!state.catalog || (!seeded && !hasHeld)) {
    return state
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneNativeChatSessionOptionRecord(state.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, seed)
  }
  return { ...commitStructuredAgentSessionOptionValues(view, held), pendingId: state.pendingId }
}

/** The model and effort a send moves a Claude chat to when the host's loaded list lacks the model
 *  it holds (a held pick, else the record's, else the launch seed's): decided at send from the list
 *  in hand, and shown as held until then. Null keeps both. */
export function structuredAgentSessionListedPicks(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  listed: AgentSessionModelCatalogResult | null
): Record<string, string> | null {
  // A host answer is read as given: one naming no rows is no loaded list.
  if (
    state.record.agent !== 'claude' ||
    (listed?.origin !== 'probe' && listed?.origin !== 'live-session') ||
    !Array.isArray(listed.models)
  ) {
    return null
  }
  const tracked = state.record.model?.value
  const model = held.model ?? (typeof tracked === 'string' ? tracked : seed?.model)
  if (!model) {
    return null
  }
  const recorded = state.record.valuesByModel[model]?.effort?.value
  const effort =
    held.effort ??
    (typeof recorded === 'string' ? recorded : seed?.model === model ? seed.effort : undefined)
  const values = { model, ...(effort ? { effort } : {}) }
  const resolved = valuesOnListedModel(values, listed.models)
  return resolved === values ? null : { ...resolved }
}
