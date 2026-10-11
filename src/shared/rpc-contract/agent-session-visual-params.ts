import { z } from 'zod'
import { isNativeChatVisualFileName, isNativeChatVisualPath } from '../native-chat-visual-directive'
import { SessionId } from './structured-agent-session-identifiers'

// `agentSession.readVisual`: one HTML visual from a structured chat's folder, read on the host that
// owns the chat. The client names only the session and a path relative to that folder; the host
// resolves the folder itself, so no client path ever reaches another host.

/** Content revision: hex digest of the file's bytes. */
const Revision = z.string().regex(/^[0-9a-f]{16,64}$/)

export const ReadVisualParams = z.union([
  z
    .object({
      sessionId: SessionId,
      path: z.string().refine(isNativeChatVisualPath, 'Invalid visual path'),
      // The revision the client already holds; a match answers `unchanged` without the bytes.
      knownRevision: Revision.optional()
    })
    .strict(),
  // An older host's reply line named `file`, a bare name in its per-chat visuals folder. Clients
  // still send it for those lines; only an older host serves it, this one answers `not_found`.
  z
    .object({
      sessionId: SessionId,
      file: z.string().refine(isNativeChatVisualFileName, 'Invalid visual file name'),
      knownRevision: Revision.optional()
    })
    .strict()
])

export type AgentSessionReadVisualParams = z.infer<typeof ReadVisualParams>

/**
 * Why a visual cannot be shown, as positively observed by the owning host. Transport loss and an
 * older host are never one of these: the client reads those as unavailable and may retry.
 */
export const AGENT_SESSION_VISUAL_READ_ERRORS = [
  'session_not_found',
  'unsupported_location',
  'not_found',
  'not_a_file',
  'outside_folder',
  'too_large',
  'not_text'
] as const

export type AgentSessionVisualReadError = (typeof AGENT_SESSION_VISUAL_READ_ERRORS)[number]

export type AgentSessionReadVisualResult =
  | { ok: true; revision: string; sizeBytes: number; html: string }
  | { ok: true; revision: string; sizeBytes: number; unchanged: true }
  | { ok: false; error: AgentSessionVisualReadError }
