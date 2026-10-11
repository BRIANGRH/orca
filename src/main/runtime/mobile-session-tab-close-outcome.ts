import type { RuntimeMobileSessionTabCloseResult } from '../../shared/runtime-types'
import type { ClientSessionTabSelectionStore } from './client-session-tab-selection'

// Why: a committed close forgets each client's selection; panes and unproven terminal tabs
// stay hidden from registered clients until the host list drops them
// (ClientSessionTabSelectionStore.forgetTabs). Both claim the host itself retired it. Claiming that
// for a close the host merely asked someone else to perform would drop a still-live tab's
// selection and could hide it with no recovery path. Hence the three outcome classes below, one
// constructor each.

// Why: declared, never assigned — the brand exists only in the type system, so
// no new field reaches mixed-version clients over the RPC wire.
declare const mobileSessionTabCloseOutcomeBrand: unique symbol

// Why: the required brand makes a bare `{ closed: true }` unassignable, forcing
// every close return site to name which outcome class it is.
export type MobileSessionTabCloseOutcome = RuntimeMobileSessionTabCloseResult & {
  readonly [mobileSessionTabCloseOutcomeBrand]: never
}

type MobileSessionTabCloseRefusalReason = NonNullable<
  RuntimeMobileSessionTabCloseResult['refusalReason']
>

// Why: the host tore the tab down (or verified its teardown) itself, so it may
// forget the client's selection. That is written here, not by the caller, so this
// outcome's name and its effect cannot drift apart.
export function committedMobileSessionTabClose(
  selections: Pick<ClientSessionTabSelectionStore, 'forgetTabs'>,
  worktreeId: string,
  closedTabIds: readonly string[],
  suppressedIds: readonly string[] = []
): MobileSessionTabCloseOutcome {
  selections.forgetTabs(worktreeId, closedTabIds, suppressedIds)
  return { closed: true } as MobileSessionTabCloseOutcome
}

// Why: the close was handed to the renderer over a fire-and-forget notifier that
// carries no acknowledgement. The renderer may legitimately decline it — an
// unresolvable worktree route, or a pinned-tab confirm the user cancels — so the
// host does not know the tab retired and must not forget it.
export function delegatedMobileSessionTabClose(): MobileSessionTabCloseOutcome {
  return { closed: true } as MobileSessionTabCloseOutcome
}

// Why: `snapshotRepublished` tells the client to restore its pruned mirror, so it
// is passed explicitly per site — some refusals deliberately skip the republish.
export function refusedMobileSessionTabClose(
  refusalReason: MobileSessionTabCloseRefusalReason,
  options: { snapshotRepublished?: boolean } = {}
): MobileSessionTabCloseOutcome {
  return {
    closed: true,
    refused: true,
    refusalReason,
    ...(options.snapshotRepublished ? { snapshotRepublished: true as const } : {})
  } as MobileSessionTabCloseOutcome
}
