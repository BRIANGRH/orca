import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { cloneNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import { valuesOnListedModel } from './agent-session-unlisted-model'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

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
 * model, and `held` picks outrank both until the host settles them, as does what a send moves
 * a model `listed` lacks to. All show as `dispatched`; derived on every read, never written into
 * the record.
 *
 * The permission mode reads its own way: the held pick, else what the host stated, else the seed.
 */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  listed: AgentSessionModelCatalogResult | null = null
): StructuredAgentSessionOptionState {
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: heldPermission, ...heldSelection } = held
  const replaced = structuredAgentSessionListedPicks(state, seed, heldSelection, listed)
  const view = modelOptionView(state, seed, { ...heldSelection, ...replaced })
  const permissionMode =
    heldPermission ?? state.permissionMode ?? seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? null
  return view.permissionMode === permissionMode ? view : { ...view, permissionMode }
}

function modelOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
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

/** What a send moves a Claude chat to when the host's loaded list lacks its model (held, else
 *  recorded, else seeded); null keeps it. */
export function structuredAgentSessionListedPicks(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  listed: AgentSessionModelCatalogResult | null
): Record<string, string> | null {
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
