// `agentSession.readVisual` — one HTML visual from a chat's folder.
//
// Additive: an older host answers `method_not_found` (a phone gets `forbidden` from the mobile
// allowlist gate on a host without the entry), and the client shows the visual as unavailable.
// The host resolves the chat's folder from its own record, the same folder the chat launches in; a
// client supplies only the session id and a path relative to it.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  ReadVisualParams,
  type AgentSessionReadVisualResult
} from '../../../../shared/rpc-contract/agent-session-visual-params'
import { readNativeChatVisualFile } from '../../../native-chat/native-chat-visual-file-read'
import { agentSessionPinnedLaunchDirectory } from '../../agent-session-record-launch-directory'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_VISUAL_METHODS = [
  defineMethod({
    name: 'agentSession.readVisual',
    permission: 'workspace',
    params: ReadVisualParams,
    handler: async (params, ctx): Promise<AgentSessionReadVisualResult> => {
      const host = await requireInstalledStructuredHost(ctx)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record) {
        return { ok: false, error: 'session_not_found' }
      }
      if (!('path' in params)) {
        return { ok: false, error: 'not_found' }
      }
      // Structured chats run on their owning runtime's own filesystem; any other location has no
      // folder this process can read.
      if (
        record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
        record.location.wslDistro
      ) {
        return { ok: false, error: 'unsupported_location' }
      }
      const folder =
        agentSessionPinnedLaunchDirectory(record) ??
        (await host.deps.resolveWorkspacePath?.(record.location.workspaceId))
      if (!folder) {
        return { ok: false, error: 'unsupported_location' }
      }
      return readNativeChatVisualFile(folder, params.path, params.knownRevision)
    }
  })
]
