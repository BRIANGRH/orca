import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionClosesInFlight } from './structured-agent-session-closes-in-flight'
import { seedStructuredAgentSessionTabIndex } from './structured-agent-session-tab-index-seed'
import { onStructuredAgentSessionHostInstalled } from '../native-chat/agent-session-wire/structured-agent-session-registry'

type RestoredSession = ReturnType<StructuredAgentSessionHost['listSessionTabs']>[number]

/** Restore reads history; only current, uncanceled targets may publish a tab. */
export async function restoreStructuredAgentSessionTabPublications(input: {
  runtime: WeakKey
  getHost: () => StructuredAgentSessionHost | null
  profileIds: readonly string[]
  prepare?: () => Promise<void>
  hydrate: () => void
  project: (session: RestoredSession) => void
}): Promise<void> {
  await getStructuredAgentSessionClosesInFlight(input.runtime).runRestoration(async (attempt) => {
    let original: { present: boolean; targets: readonly string[] } | undefined
    const discover = (host: StructuredAgentSessionHost): void => {
      if (original) {
        return
      }
      const index = host.getPersistedVisibleSessionTabIndex?.() ?? {
        present: false,
        sessionIds: []
      }
      original = {
        present: index.present,
        targets: [...(index.present ? index.sessionIds : input.profileIds)]
      }
    }
    const stopDiscovering = onStructuredAgentSessionHostInstalled(discover)
    try {
      await input.prepare?.()
      const host = input.getHost()
      if (host) {
        discover(host)
      }
      const membership = original ?? { present: false, targets: input.profileIds }
      const { targets } = membership
      await host?.restoreReadableSessions(targets)
      input.hydrate()
      const restored = (host?.listSessionTabs() ?? []).map((session) => {
        let sessionId = session.sessionId
        while (sessionId.startsWith('agent-session:')) {
          sessionId = sessionId.slice('agent-session:'.length)
        }
        return { ...session, sessionId }
      })
      const eligible = targets.filter((sessionId) => !attempt.signalFor(sessionId).aborted)
      if (!membership.present) {
        await seedStructuredAgentSessionTabIndex(
          host,
          eligible,
          restored
            .filter((session) => eligible.includes(session.sessionId))
            .map((session) => session.sessionId)
        )
      }
      const current = host?.getPersistedVisibleSessionTabIndex?.() ?? {
        present: false,
        sessionIds: []
      }
      const visible = new Set(current.present ? current.sessionIds : eligible)
      for (const session of restored) {
        if (!attempt.signalFor(session.sessionId).aborted && visible.has(session.sessionId)) {
          input.project(session)
        }
      }
    } finally {
      stopDiscovering()
    }
  })
}
