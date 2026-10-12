import { observeStructuredSessionUserAction } from './native-chat/structured-agent-session-user-actions'
/** Model the existing sender's allocation and target-qualified dispatch at the renderer seam. */
export function admitUserResumeRequest(sessionId: string, clientMessageId: string): void {
  const action = { sessionId, clientMessageId, kind: 'send' as const }
  observeStructuredSessionUserAction({ kind: 'admitted', action })
  observeStructuredSessionUserAction({
    kind: 'issued',
    action: { ...action, target: { kind: 'local' } }
  })
}
