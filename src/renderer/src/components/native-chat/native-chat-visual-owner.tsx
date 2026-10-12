import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'

/** The structured chat a transcript belongs to: its host, its workspace and its tab. */
export type NativeChatVisualOwner = {
  target: RuntimeClientTarget
  worktreeId: string
  /** The chat's tab, whose folder a visual's path is relative to. */
  tabId: string
}

export const NativeChatVisualOwnerContext = createContext<NativeChatVisualOwner | null>(null)

/** Null outside a structured chat's transcript, where no visual can be read. */
export function useNativeChatVisualOwner(): NativeChatVisualOwner | null {
  return useContext(NativeChatVisualOwnerContext)
}

/** Names the structured chat below it as the owner of the visuals its replies show. */
export function NativeChatVisualOwnerProvider({
  target,
  tabId,
  children
}: {
  target: RuntimeClientTarget
  tabId: string
  children: ReactNode
}): React.JSX.Element {
  // Until the tab's workspace is known there is no workspace to open a visual's tab in.
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const owner = useMemo<NativeChatVisualOwner | null>(
    () =>
      worktreeId
        ? {
            target:
              environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
            worktreeId,
            tabId
          }
        : null,
    [environmentId, tabId, worktreeId]
  )
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      {children}
    </NativeChatVisualOwnerContext.Provider>
  )
}
