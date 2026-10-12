import type Database from '../../../../sqlite/sync-database'

// Why: shared so every dispatch failure path breaks the circuit at the same accumulated failure_count.
export const DISPATCH_CIRCUIT_BREAK_FAILURES = 3

/** Failures a new Dispatch inherits, so the breaker accumulates across retries of one Task. */
export function priorTaskDispatchFailures(db: Database.Database, taskId: string): number {
  const prior: unknown = db
    .prepare('SELECT MAX(failure_count) AS max_failures FROM dispatch_contexts WHERE task_id = ?')
    .get(taskId)
  return prior &&
    typeof prior === 'object' &&
    'max_failures' in prior &&
    typeof prior.max_failures === 'number'
    ? prior.max_failures
    : 0
}
