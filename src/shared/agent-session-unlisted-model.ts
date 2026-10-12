// A model the account's loaded list no longer offers gives way to the list's default, so the next
// send runs a model that exists instead of failing.

const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

type ListedModelRow = { id: string; isDefault?: boolean; efforts: readonly { value: string }[] }

/** `previous` if `supported` offers it, else the nearest offered level (the higher on a tie). */
export function nearestAgentEffort(
  previous: string,
  supported: readonly string[]
): string | undefined {
  const rank = (level: string): number => EFFORT_RANK.indexOf(level)
  const distance = (level: string): number => Math.abs(rank(level) - rank(previous))
  if (supported.includes(previous)) {
    return previous
  }
  if (rank(previous) === -1) {
    return undefined
  }
  return supported
    .filter((level) => rank(level) !== -1)
    .sort((a, b) => distance(a) - distance(b) || rank(b) - rank(a))[0]
}

/** `values` on the list's default (else its first row) when a loaded list lacks `values.model`,
 *  effort moved to the nearest level that row offers; `values` itself otherwise. */
export function valuesOnListedModel(
  values: Readonly<Record<string, string>>,
  models: readonly ListedModelRow[]
): Readonly<Record<string, string>> {
  const model = values.model
  if (model === undefined || models.length === 0 || models.some((row) => row.id === model)) {
    return values
  }
  const target = models.find((row) => row.isDefault) ?? models[0]!
  const { effort, ...rest } = values
  const efforts = target.efforts.map((choice) => choice.value)
  const carried = effort === undefined ? undefined : nearestAgentEffort(effort, efforts)
  return { ...rest, model: target.id, ...(carried ? { effort: carried } : {}) }
}
