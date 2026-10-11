import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionClosesInFlight } from './structured-agent-session-closes-in-flight'
import { seedStructuredAgentSessionTabIndex } from './structured-agent-session-tab-index-seed'

type RestoredSession = ReturnType<StructuredAgentSessionHost['listSessionTabs']>[number]

/** Restore reads history; only current, uncanceled targets may publish a tab. */
export async function restoreStructuredAgentSessionTabPublications(input: {
  runtime: WeakKey
  host: StructuredAgentSessionHost | null
  profileIds: readonly string[]
  hydrate: () => void
  project: (session: RestoredSession) => void
}): Promise<void> {
  const { host } = input
  const index = host?.getPersistedVisibleSessionTabIndex?.() ?? { present: false, sessionIds: [] }
  const targets = index.present ? index.sessionIds : input.profileIds
  await getStructuredAgentSessionClosesInFlight(input.runtime).runPublications(
    targets,
    async (signals) => {
      await host?.restoreReadableSessions(targets)
      input.hydrate()
      const restored = (host?.listSessionTabs() ?? []).map((session) => {
        let sessionId = session.sessionId
        while (sessionId.startsWith('agent-session:')) {
          sessionId = sessionId.slice('agent-session:'.length)
        }
        return { ...session, sessionId }
      })
      const eligible = targets.filter((sessionId) => !signals.get(sessionId)?.aborted)
      if (!index.present) {
        await seedStructuredAgentSessionTabIndex(
          host,
          eligible,
          restored
            .filter((session) => eligible.includes(session.sessionId))
            .map((session) => session.sessionId)
        )
      }
      const current = host?.getPersistedVisibleSessionTabIndex?.() ?? index
      const visible = new Set(current.present ? current.sessionIds : eligible)
      for (const session of restored) {
        if (!signals.get(session.sessionId)?.aborted && visible.has(session.sessionId)) {
          input.project(session)
        }
      }
    }
  )
}
