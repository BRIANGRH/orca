// A send an adapter prepared once with the stopped history it carries, handed back to the same
// adapter's dispatch to write as is.

/** A send its adapter prepared once with stopped history: dispatch writes exactly its payload, and
 *  `carries` names exactly the stopped messages inside it, oldest first. Each adapter's own class. */
export type AgentSessionPreparedDispatch = { readonly carries: readonly string[] }

/** The payload `prepared` holds when this adapter's own class made it; another's is Orca's bug. */
export function preparedByAdapter<TPrepared extends AgentSessionPreparedDispatch>(
  prepared: AgentSessionPreparedDispatch | undefined,
  kind: abstract new (...args: never[]) => TPrepared
): TPrepared | undefined {
  if (prepared === undefined || prepared instanceof kind) {
    return prepared
  }
  throw new Error('a send was prepared by another agent')
}
