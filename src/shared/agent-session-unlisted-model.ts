// A remembered model the account's loaded list no longer offers gives way to the list's default,
// so a new chat starts on a model that runs instead of failing its first message.

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

/** `seed` on the list's default (else its first row) when a loaded list lacks `seed.model`, its
 *  effort moved to the nearest level that row offers; `seed` itself otherwise. */
export function seedOnListedModel(
  seed: Readonly<Record<string, string>>,
  models: readonly ListedModelRow[]
): Readonly<Record<string, string>> {
  const model = seed.model
  if (model === undefined || models.length === 0 || models.some((row) => row.id === model)) {
    return seed
  }
  const target = models.find((row) => row.isDefault) ?? models[0]!
  const { effort, ...rest } = seed
  const efforts = target.efforts.map((choice) => choice.value)
  const carried = effort === undefined ? undefined : nearestAgentEffort(effort, efforts)
  return { ...rest, model: target.id, ...(carried ? { effort: carried } : {}) }
}
